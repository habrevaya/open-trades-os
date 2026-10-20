import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, imports as rules, isSystem, money as m, time, type Permission } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf,
  ConflictError, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";
import { remember, replayed } from "./once";
import { byExternal } from "./provenance";
import * as workbooks from "../imports/workbook";
import { dryRun } from "../http/dry-run";
import * as customers from "./customers";
import * as contacts from "./contacts";
import * as equipment from "./equipment";
import * as pricebook from "./pricebook";
import * as jobs from "./jobs";
import * as billing from "./billing";
import * as estimates from "./estimates";
import * as customerNotes from "./customer-notes";
import { CustomerCreate } from "../contracts/customers";
import { JobCreate } from "../contracts/jobs";
import { registerEquipment } from "../contracts/equipment";
import { createPriceBookItem } from "../contracts/pricebook";
import { createInvoice, recordPayment } from "../contracts/billing";
import { createEstimate } from "../contracts/estimates";
import { addCustomerNote } from "../contracts/customer-notes";
import { scheduleVisit } from "../contracts/jobs";

/**
 * BRINGING IN A SPREADSHEET (M30)
 *
 * An owner uploads a file, says which column is which, checks it and loads
 * it, all from `Settings > Bring in a spreadsheet`. What this file does NOT
 * do is load anything itself. Each row becomes the input of the create the
 * API already has for that record (`POST /v1/customers`, `/v1/equipment`,
 * `/v1/pricebook/items`, `/v1/jobs`, `/v1/invoices`, `/v1/payments`), parsed
 * by that route's own schema and passed to that route's own service, with
 * the row's provenance as its `externalRef`. So the history rules (a 2021
 * invoice posts in 2021 and never into a closed period), the imported
 * numbers, the tax as charged and the refusal of a second copy are exactly
 * the API's: a second importer would be a second set of rules, and the
 * first difference between them would be somebody's books.
 *
 * THREE STEPS, AND THE MIDDLE ONE IS THE POINT.
 *
 *   1. Map. The columns are guessed from the headers (core/imports) and the
 *      owner corrects them. Every row is read as it will land, and a row that
 *      can never load ("no invoice date", "half an address") is refused in
 *      words before anything is tried.
 *   2. Check. A batch at a time, the rows go through the real creates inside
 *      the dry run every bulk route offers (`http/dry-run.ts`): run, look,
 *      roll back. Each row gets its own savepoint, so one refusal does not
 *      hide the next, and the answer is the route's rather than a prediction.
 *   3. Load. A batch at a time, the rows the check passed go in through the
 *      same creates in ONE transaction: the whole batch or none of it.
 *
 * A SECOND UPLOAD DOES NOT DUPLICATE. Each row's record carries
 * `externalRef: { source, id }`, the id being the file's own id column, or
 * the code or number that already names one record, or failing both a hash
 * of the row. A row whose key is already here is skipped and says which
 * record it already is.
 */

type Kind = rules.ImportKind;
type Run = typeof schema.importRun.$inferSelect;
type Outcome = "waiting" | "ready" | "already" | "refused" | "loaded";

/** The permissions each kind's creates ask for, checked once up front rather than refused row by row. */
const NEEDS: Record<Kind, Permission[]> = {
  customers: ["customer:write"],
  equipment: ["customer:read", "equipment:write"],
  pricebook: ["pricebook:write"],
  jobs: ["customer:read", "job:write"],
  invoices: ["customer:read", "invoice:write", "payment:collect"],
  payments: ["customer:read", "invoice:read", "payment:collect"],
  estimates: ["customer:read", "estimate:write"],
  notes: ["customer:read", "customer:write"],
  visits: ["job:read", "visit:write"],
};

/** The table a kind's provenance lives on, by its name in SQL. */
const TABLE: Record<Kind, string> = {
  customers: "customer", equipment: "equipment", pricebook: "price_book_item", jobs: "job", invoices: "invoice",
  payments: "payment", estimates: "estimate", notes: "customer_note", visits: "visit",
};

const LIST_LIMIT = 500;
const PREVIEW_ROWS = 10;

/* ---------------------------------------------------------------- reading */

async function loadRun(tx: Database, id: string): Promise<Run> {
  const [run] = await tx.select().from(schema.importRun).where(eq(schema.importRun.id, id)).limit(1);
  if (!run) throw new NotFoundError("Spreadsheet");
  return run;
}

const kindOf = (run: Run): Kind => {
  if (!rules.isImportKind(run.kind)) throw new Error(`Unknown import kind ${run.kind}`);
  return run.kind;
};

async function countsOf(tx: Database, runIds: string[]): Promise<Map<string, Record<Outcome, number>>> {
  const out = new Map<string, Record<Outcome, number>>();
  for (const id of runIds) out.set(id, { waiting: 0, ready: 0, already: 0, refused: 0, loaded: 0 });
  if (runIds.length === 0) return out;
  const rows = await tx.select({
    runId: schema.importRow.runId, outcome: schema.importRow.outcome, n: sql<number>`count(*)::int`,
  }).from(schema.importRow)
    .where(inArray(schema.importRow.runId, runIds))
    .groupBy(schema.importRow.runId, schema.importRow.outcome);
  for (const row of rows) {
    const counts = out.get(row.runId);
    if (counts && row.outcome in counts) counts[row.outcome as Outcome] = Number(row.n);
  }
  return out;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function summary(run: Run, counts: Record<Outcome, number>) {
  return {
    id: run.id,
    kind: kindOf(run),
    fileName: run.fileName,
    sheetName: run.sheetName,
    source: run.source,
    holdAutomations: run.holdAutomations,
    status: run.status as "mapping" | "checking" | "checked" | "loading" | "finished",
    rows: run.rowCount,
    counts,
    createdAt: run.createdAt.toISOString(),
    checkedAt: iso(run.checkedAt),
    finishedAt: iso(run.finishedAt),
  };
}

async function todayFor(tx: Database, ctx: ServiceContext): Promise<{ today: string; timeZone: string }> {
  const timeZone = await timezoneOf(tx, ctx.actor.organizationId);
  return { today: time.dateIn(new Date(), timeZone), timeZone };
}

async function detail(tx: Database, ctx: ServiceContext, run: Run) {
  const kind = kindOf(run);
  const counts = (await countsOf(tx, [run.id])).get(run.id)!;
  const columns = run.columns;
  const { today } = await todayFor(tx, ctx);

  const first = await tx.select({ cells: schema.importRow.cells }).from(schema.importRow)
    .where(eq(schema.importRow.runId, run.id)).orderBy(asc(schema.importRow.rowNumber)).limit(20);
  const samples = run.header.map((_, i) => first.map((r) => (r.cells[i] ?? "").trim()).find((c) => c !== "") ?? "");

  const showing = await tx.select({ rowNumber: schema.importRow.rowNumber, cells: schema.importRow.cells })
    .from(schema.importRow)
    .where(and(eq(schema.importRow.runId, run.id), sql`${schema.importRow.outcome} <> 'refused'`))
    .orderBy(asc(schema.importRow.rowNumber)).limit(PREVIEW_ROWS);
  const preview = showing.map((row) => ({
    row: row.rowNumber,
    values: rules.readRow(kind, columns, row.cells, { dayFirst: run.dayFirst, today }).values,
  }));

  const lines = (outcome: Outcome) => tx.select({
    row: schema.importRow.rowNumber, reason: schema.importRow.reason,
    recordId: schema.importRow.recordId, recordLabel: schema.importRow.recordLabel,
  }).from(schema.importRow)
    .where(and(eq(schema.importRow.runId, run.id), eq(schema.importRow.outcome, outcome)))
    .orderBy(asc(schema.importRow.rowNumber)).limit(LIST_LIMIT);

  const [mapping] = run.mappingId
    ? await tx.select({ name: schema.importMapping.name }).from(schema.importMapping)
      .where(eq(schema.importMapping.id, run.mappingId)).limit(1)
    : [];

  return {
    ...summary(run, counts),
    dayFirst: run.dayFirst,
    header: run.header,
    columns,
    samples,
    fields: rules.fieldsOf(kind).map((f) => ({ key: f.key, label: f.label, required: f.required === true })),
    problems: problemsOf(run),
    mappingName: mapping?.name ?? null,
    preview,
    refused: await lines("refused"),
    skipped: await lines("already"),
  };
}

function problemsOf(run: Run): string[] {
  const kind = kindOf(run);
  const problems = rules.mappingProblems(kind, run.columns);
  if (run.columns.length !== run.header.length) problems.unshift("The columns do not line up with the file's header.");
  return problems;
}

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "data:import", async (tx) => {
    const runs = await tx.select().from(schema.importRun).orderBy(desc(schema.importRun.createdAt)).limit(100);
    const counts = await countsOf(tx, runs.map((r) => r.id));
    return { imports: runs.map((run) => summary(run, counts.get(run.id)!)) };
  });
}

export async function get(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "data:import", async (tx) => detail(tx, ctx, await loadRun(tx, input.id)));
}

/* ---------------------------------------------------------- reading the rows */

/** A row matched on everything mapped from it, when nothing in it is an id. */
function rowHash(values: Record<string, string>): string {
  const stable = JSON.stringify(Object.keys(values).sort().map((k) => [k, values[k]]));
  return `row-${createHash("sha256").update(stable).digest("hex").slice(0, 24)}`;
}

/**
 * EVERY ROW, READ AGAIN AGAINST THE COLUMNS AS THEY NOW ARE.
 *
 * Each row is read as it will land, given the key its record will carry, and
 * refused in words when the reading alone says it can never load. Two rows
 * with the same key are the same record, so the second is refused naming the
 * first: loading it would either be skipped as already here or, worse, be a
 * different row the owner thinks went in. While the mapping itself is
 * incomplete, no row is judged: "Code is empty" on all two thousand rows
 * says less than "No column is set to Code" once.
 */
async function reread(tx: Database, ctx: ServiceContext, run: Run): Promise<void> {
  const kind = kindOf(run);
  const rows = await tx.select({ id: schema.importRow.id, rowNumber: schema.importRow.rowNumber, cells: schema.importRow.cells })
    .from(schema.importRow).where(eq(schema.importRow.runId, run.id)).orderBy(asc(schema.importRow.rowNumber));
  const incomplete = problemsOf(run).length > 0;
  const { today } = await todayFor(tx, ctx);
  const seenKey = new Map<string, number>();
  const seenNumber = new Map<string, number>();
  const one = rules.KIND_LABEL[kind].row;
  const grouped = rules.isGrouped(kind);
  const updates = rows.map((row) => {
    if (incomplete) {
      return {
        id: row.id, rowNumber: row.rowNumber, outcome: "waiting", reason: null as string | null,
        key: null as string | null, partOf: null as number | null, extra: [] as string[],
      };
    }
    const read = rules.readRow(kind, run.columns, row.cells, { dayFirst: run.dayFirst, today });
    const problems = [...read.problems];
    const natural = rules.naturalKey(kind, read.values);
    const key = natural ?? rowHash(read.values);
    /** What is wrong with the row's id rather than its reading, kept when its record's rows are read together. */
    const extra: string[] = [];
    if (natural !== null && natural.length > rules.MAX_KEY_LENGTH) {
      extra.push(`Its id is longer than ${rules.MAX_KEY_LENGTH} characters.`);
    }
    const before = seenKey.get(key);
    /** Another line of an invoice, or another invoice a payment paid: part of the first row with its id. */
    if (before !== undefined && grouped && natural !== null) {
      return { id: row.id, rowNumber: row.rowNumber, outcome: "waiting", reason: null as string | null, key, partOf: before, extra };
    }
    if (before !== undefined) {
      extra.push(natural !== null
        ? `Row ${before} has the same id, ${key}. Each ${one} once.`
        : `It is exactly the same as row ${before}.`);
    } else {
      seenKey.set(key, row.rowNumber);
    }
    /* A second row with the same number or code would be refused by the create; said here, naming the first. */
    const number = kind === "pricebook" ? read.values["code"]
      : kind === "jobs" || kind === "invoices" || kind === "estimates" ? read.values["number"] : undefined;
    if (number !== undefined && before === undefined) {
      const earlier = seenNumber.get(number);
      if (earlier !== undefined) {
        extra.push(`Row ${earlier} has the same ${kind === "pricebook" ? "code" : "number"}, ${number}.`);
      } else {
        seenNumber.set(number, row.rowNumber);
      }
    }
    problems.push(...extra);
    return {
      id: row.id,
      rowNumber: row.rowNumber,
      outcome: problems.length > 0 ? "refused" : "waiting",
      reason: problems.length > 0 ? problems.join(" ") : null,
      key,
      partOf: null as number | null,
      extra,
    };
  });

  /**
   * THE ROWS OF ONE RECORD, READ TOGETHER. A refusal of any of them is the
   * whole record's, said once on its first row and carried by the rest, so
   * the file of refused rows hands back every line of the invoice to fix
   * together rather than the half that would load on its own.
   */
  if (grouped && !incomplete) {
    const byNumber = new Map(rows.map((r) => [r.rowNumber, r]));
    const heads = new Map(updates.filter((u) => u.partOf === null).map((u) => [u.rowNumber, u]));
    const members = new Map<number, typeof updates>();
    for (const u of updates) {
      if (u.partOf === null) continue;
      members.set(u.partOf, [...(members.get(u.partOf) ?? []), u]);
    }
    for (const [headNumber, parts] of members) {
      const head = heads.get(headNumber)!;
      const together = [head, ...parts];
      const read = readTogether(kind, run, together.map((u) => ({ rowNumber: u.rowNumber, cells: byNumber.get(u.rowNumber)!.cells })), today);
      const said = [...head.extra, ...read.problems];
      const reason = said.length > 0 ? said.join(" ") : null;
      for (const u of together) {
        u.outcome = reason ? "refused" : "waiting";
        u.reason = reason;
      }
    }
    /** A payment on one row is still read as a payment: its amount, and whose it is. */
    if (kind === "payments") {
      for (const head of heads.values()) {
        if (members.has(head.rowNumber) || head.outcome === "refused") continue;
        const read = readTogether(kind, run, [{ rowNumber: head.rowNumber, cells: byNumber.get(head.rowNumber)!.cells }], today);
        if (read.problems.length > 0) { head.outcome = "refused"; head.reason = read.problems.join(" "); }
      }
    }
  }

  for (let i = 0; i < updates.length; i += 1000) {
    const chunk = updates.slice(i, i + 1000);
    await tx.execute(sql`
      update public.import_row r
      set outcome = v.outcome, reason = v.reason, source_key = v.key, part_of = null,
          record_id = null, record_label = null, updated_at = now()
      from unnest(
        ${sql.param(chunk.map((u) => u.id))}::uuid[],
        ${sql.param(chunk.map((u) => u.outcome))}::text[],
        ${sql.param(chunk.map((u) => u.reason))}::text[],
        ${sql.param(chunk.map((u) => u.key))}::text[]
      ) as v(id, outcome, reason, key)
      where r.id = v.id`);
  }
  /** Each record's further rows, marked as part of its first, one record at a time. */
  const partsOf = new Map<number, string[]>();
  for (const u of updates) {
    if (u.partOf !== null) partsOf.set(u.partOf, [...(partsOf.get(u.partOf) ?? []), u.id]);
  }
  for (const [head, ids] of partsOf) {
    await tx.update(schema.importRow).set({ partOf: head }).where(inArray(schema.importRow.id, ids));
  }
}

/**
 * Several rows as one record: each read as a line when they are an
 * invoice's, then together (`readGroup`). A row's own problems are said with
 * its number, because the reason lands on every row of the record.
 */
function readTogether(
  kind: Kind, run: Run, rows: ReadonlyArray<{ rowNumber: number; cells: string[] }>, today: string,
): rules.GroupRead {
  const line = rows.length > 1;
  const read = rows.map((r) => ({ row: r.rowNumber, ...rules.readRow(kind, run.columns, r.cells, { dayFirst: run.dayFirst, today, line }) }));
  const group = rules.readGroup(kind, read.map((r) => ({ row: r.row, values: r.values })));
  const own = read.filter((r) => r.problems.length > 0)
    .map((r) => (rows.length > 1 ? `Row ${r.row}: ${r.problems.join(" ")}` : r.problems.join(" ")));
  return { ...group, problems: [...own, ...group.problems] };
}

/* --------------------------------------------------------------- upload, map */

/** The most base64 text a five megabyte file can come to, with room for line breaks nobody sent. */
const MAX_BASE64 = Math.ceil((rules.MAX_BYTES * 4) / 3) + 16;

/**
 * THE FILE, AS A HEADER AND ROWS OF TEXT, WHICHEVER WAY IT CAME.
 *
 * A CSV is text. A workbook is bytes (sent as base64, because the API answers
 * in JSON) and one of its sheets is read into the same rows, so everything
 * after this point, the mapping, the checks, the loads, is one code path for
 * both. A row of a workbook keeps the row number it has in the spreadsheet.
 */
async function upload(input: {
  csv?: string | undefined; workbook?: string | undefined; sheet?: string | undefined;
}): Promise<{ header: string[]; rows: string[][]; numbers: number[] | null; sheet: string | null }> {
  if (input.csv !== undefined && input.workbook !== undefined) {
    throw new ConflictError("Send the file as a CSV or as a workbook, not both.");
  }
  if (input.workbook !== undefined) {
    if (input.workbook.length > MAX_BASE64) {
      throw new ConflictError(rules.tooBigMessage(Math.floor((input.workbook.length * 3) / 4)));
    }
    try {
      const read = await workbooks.readSheet(Buffer.from(input.workbook, "base64"), input.sheet);
      return { header: read.header, rows: read.rows, numbers: read.numbers, sheet: read.sheet };
    } catch (error) {
      if (error instanceof workbooks.WorkbookRefused) throw new ConflictError(error.message);
      throw error;
    }
  }
  if (input.csv === undefined) throw new ConflictError("Send the file to bring in.");
  if (input.sheet !== undefined) throw new ConflictError("A CSV file has no sheets. Send a workbook to choose one.");
  const file = rules.readFile(input.csv, Buffer.byteLength(input.csv, "utf8"));
  if (!file.ok) throw new ConflictError(file.why);
  return { header: file.header, rows: file.rows, numbers: null, sheet: null };
}

/**
 * THE SHEETS OF A WORKBOOK, for choosing one.
 *
 * Each with its rows and the start of its header, and why it cannot be
 * brought in when it cannot. Nothing is kept: the file is sent again with the
 * sheet chosen, so there is no half uploaded file to clean up and a workbook
 * is never stored as a workbook.
 */
export async function sheets(ctx: ServiceContext, input: { workbook: string }) {
  assertCan(ctx.actor, "data:import");
  if (input.workbook.length > MAX_BASE64) {
    throw new ConflictError(rules.tooBigMessage(Math.floor((input.workbook.length * 3) / 4)));
  }
  try {
    return { sheets: await workbooks.listSheets(Buffer.from(input.workbook, "base64")) };
  } catch (error) {
    if (error instanceof workbooks.WorkbookRefused) throw new ConflictError(error.message);
    throw error;
  }
}

export async function start(
  ctx: ServiceContext,
  input: {
    kind: Kind; fileName: string; csv?: string | undefined; workbook?: string | undefined; sheet?: string | undefined;
    holdAutomations?: boolean | undefined;
  },
) {
  return guardedWrite(ctx, "data:import", async (tx) => {
    const again = await replayed<{ id: string }>(tx, ctx, "import_start");
    if (again) return detail(tx, ctx, await loadRun(tx, again.id));

    const file = await upload(input);

    /**
     * A FILE SHAPED LIKE ONE BEFORE MAPS ITSELF. The newest mapping saved for
     * this kind of file with exactly these headers, in any order.
     */
    const [saved] = await tx.select().from(schema.importMapping)
      .where(and(
        eq(schema.importMapping.kind, input.kind),
        eq(schema.importMapping.headerKey, rules.headerKey(file.header)),
      ))
      .orderBy(desc(schema.importMapping.updatedAt)).limit(1);
    const columns = saved ? rules.columnsFromSaved(file.header, saved.columns) : rules.guessColumns(input.kind, file.header);

    const [run] = await tx.insert(schema.importRun).values({
      organizationId: ctx.actor.organizationId,
      kind: input.kind,
      fileName: input.fileName.trim().slice(0, 300) || (file.sheet === null ? "spreadsheet.csv" : "workbook.xlsx"),
      sheetName: file.sheet,
      source: saved?.source ?? "spreadsheet",
      dayFirst: saved?.dayFirst ?? false,
      /** On unless the owner said otherwise: a file of history is not news to text anybody about. */
      holdAutomations: input.holdAutomations ?? true,
      header: file.header,
      columns,
      mappingId: saved?.id ?? null,
      status: "mapping",
      rowCount: file.rows.length,
      createdByUserId: isSystem(ctx.actor) ? null : ctx.actor.userId,
    }).returning();

    for (let i = 0; i < file.rows.length; i += 1000) {
      await tx.insert(schema.importRow).values(file.rows.slice(i, i + 1000).map((cells, j) => ({
        organizationId: ctx.actor.organizationId,
        runId: run!.id,
        rowNumber: file.numbers?.[i + j] ?? i + j + 2,
        cells,
      })));
    }
    await reread(tx, ctx, run!);
    await audit(tx, ctx, "import.started", "import_run", run!.id, null, {
      kind: input.kind, fileName: run!.fileName, sheet: file.sheet, rows: file.rows.length, mapping: saved?.name ?? null,
      holdAutomations: run!.holdAutomations,
    });
    await remember(tx, ctx, "import_start", run!.id, { id: run!.id });
    return detail(tx, ctx, run!);
  });
}

export async function map(
  ctx: ServiceContext,
  input: {
    id: string; columns: Array<string | null>; source: string; dayFirst: boolean; saveAs?: string | undefined;
    holdAutomations?: boolean | undefined;
  },
) {
  return guardedWrite(ctx, "data:import", async (tx) => {
    const run = await loadRun(tx, input.id);
    const kind = kindOf(run);
    if (run.status === "loading" || run.status === "finished") {
      throw new ConflictError(
        "Rows from this file are already loaded, so its columns stay as they were. To map it differently, "
        + "bring the file in again: what this one loaded is skipped as already here.",
      );
    }
    if (input.columns.length !== run.header.length) {
      throw new UnprocessableError("One field per column", [{
        path: "columns", message: `The file has ${run.header.length} columns and ${input.columns.length} were sent.`,
      }]);
    }
    const known = new Set(rules.fieldsOf(kind).map((f) => f.key));
    const columns = input.columns.map((c) => (c === null || c === "" ? null : c));
    const stranger = columns.find((c) => c !== null && !known.has(c));
    if (stranger) {
      throw new UnprocessableError("Not a field", [{
        path: "columns", message: `"${stranger}" is not something a ${rules.KIND_LABEL[kind].row} has.`,
      }]);
    }

    let mappingId = run.mappingId;
    const name = input.saveAs?.trim();
    if (name) {
      /** Saving under a name it already has replaces it, which is what the screen says it does. */
      const [saved] = await tx.insert(schema.importMapping).values({
        organizationId: ctx.actor.organizationId,
        kind,
        name,
        headerKey: rules.headerKey(run.header),
        columns: rules.savedColumns(run.header, columns),
        source: input.source,
        dayFirst: input.dayFirst,
        createdByUserId: isSystem(ctx.actor) ? null : ctx.actor.userId,
      }).onConflictDoUpdate({
        target: [schema.importMapping.organizationId, schema.importMapping.kind, schema.importMapping.name],
        set: {
          headerKey: rules.headerKey(run.header),
          columns: rules.savedColumns(run.header, columns),
          source: input.source,
          dayFirst: input.dayFirst,
          updatedAt: new Date(),
        },
      }).returning({ id: schema.importMapping.id });
      mappingId = saved!.id;
    }

    const holdAutomations = input.holdAutomations ?? run.holdAutomations;
    const [updated] = await tx.update(schema.importRun).set({
      columns, source: input.source, dayFirst: input.dayFirst, mappingId, holdAutomations,
      status: "mapping", checkedAt: null, updatedAt: new Date(),
    }).where(eq(schema.importRun.id, run.id)).returning();
    await reread(tx, ctx, updated!);
    await audit(tx, ctx, "import.mapped", "import_run", run.id,
      { columns: run.columns, source: run.source, dayFirst: run.dayFirst, holdAutomations: run.holdAutomations },
      { columns, source: input.source, dayFirst: input.dayFirst, savedAs: name ?? null, holdAutomations });
    return detail(tx, ctx, updated!);
  });
}

/* ---------------------------------------------------------------- one row */

interface Pending {
  id: string; rowNumber: number; cells: string[]; sourceKey: string | null;
  /** The other rows of the same record, in file order: an invoice's further lines, a payment's further invoices. */
  parts: Array<{ rowNumber: number; cells: string[] }>;
}
interface RowResult { id: string; outcome: Outcome; reason: string | null; recordId: string | null; recordLabel: string | null }

/** A row the creates refused, carrying where in the batch it was. */
class RowRefused extends Error {
  constructor(readonly index: number, readonly reason: string) {
    super(reason);
    this.name = "RowRefused";
  }
}

/**
 * The service context a row's creates run under: the owner's, with no
 * idempotency key of the upload's own, and the file named, so every event
 * the creates raise says it came from this file and the workflow engine can
 * hold it when the file says so.
 */
function rowContext(ctx: ServiceContext, db: Database, run: Run): ServiceContext {
  return { actor: ctx.actor, db, importRunId: run.id, ...(ctx.agentId ? { agentId: ctx.agentId } : {}) };
}

const SAID: Record<string, string> = {
  name: "Name", email: "Email", phone: "Phone", line1: "Street", line2: "Street, second line", city: "City",
  state: "State", postalCode: "Zip", code: "Code", price: "Price", cost: "Cost", category: "What it is",
  summary: "What the job was", issuedOn: "Invoice date", dueOn: "Due date", receivedAt: "Paid on",
  completedAt: "Finished on", cancelledAt: "Finished on", amount: "Amount paid", unitPrice: "Before tax",
  taxAmount: "Tax", serialNumber: "Serial number", tags: "Tags", total: "Total",
};

/**
 * What a create refused, as a sentence about the row. A refusal is something
 * the owner can act on: a clash with what is here, a value that cannot be
 * what it says, a closed period. Anything else is a bug and goes up as one.
 */
function refusalOf(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  switch (error.name) {
    case "ConflictError":
    case "NotFoundError":
    case "PermissionError":
    case "PeriodClosedError":
      return error.message;
    case "UnprocessableError": {
      const issues = (error as UnprocessableError).issues;
      return issues.length > 0 ? issues.map((i) => i.message).join(" ") : error.message;
    }
    case "ZodError": {
      const issues = (error as Error & { issues?: Array<{ path: (string | number)[]; message: string }> }).issues ?? [];
      return issues.map((issue) => {
        const last = issue.path.filter((p): p is string => typeof p === "string").at(-1);
        return last ? `${SAID[last] ?? last}: ${issue.message}.` : `${issue.message}.`;
      }).join(" ") || "Something in the row is not in the right form.";
    }
    default:
      return null;
  }
}

/** A day in the company's calendar as an instant: midday, or now when it is today, so today is never the future. */
function instantOf(date: string, today: string, timeZone: string): string {
  return (date === today ? new Date() : time.instantOfLocal(date, 12 * 60, timeZone)).toISOString();
}

/** The record a provenance key already names, if one does. */
async function claimed(tx: Database, kind: Kind, source: string, key: string): Promise<string | null> {
  const rows = await tx.execute<{ id: string }>(sql`
    select id from ${sql.raw(`public.${TABLE[kind]}`)}
    where source_system = ${source} and source_id = ${key} limit 1`);
  return rows[0]?.id ?? null;
}

/**
 * Whose a unit, a job or an invoice is: the customer a customers file brought
 * in under the same source and that id, or the one customer with that email.
 * Never by name, because a name is not unique and a job put on the wrong
 * Smith's account is worse than a row refused. Read under the company's own
 * row level security, so an id another company brought in is simply not
 * there.
 */
async function customerFor(tx: Database, source: string, values: Record<string, string>): Promise<{ id: string; name: string }> {
  const ref = values["customerRef"];
  if (ref !== undefined) {
    const [found] = await tx.select({ id: schema.customer.id, name: schema.customer.name }).from(schema.customer)
      .where(and(byExternal(schema.customer, { externalSource: source, externalId: ref }), isNull(schema.customer.deletedAt)))
      .limit(1);
    if (!found) {
      throw new ConflictError(
        `No customer brought in from "${source}" has the id ${ref}. Bring in the customers file first, `
        + "under the same name for where it came from.",
      );
    }
    return found;
  }
  const email = values["customerEmail"]!;
  const found = await tx.select({ id: schema.customer.id, name: schema.customer.name }).from(schema.customer)
    .where(and(sql`lower(${schema.customer.email}) = lower(${email})`, isNull(schema.customer.deletedAt)))
    .limit(2);
  if (found.length === 0) throw new ConflictError(`No customer has the email ${email}.`);
  if (found.length > 1) {
    throw new ConflictError(`More than one customer has the email ${email}. Add a column with the customer's id so it is clear which.`);
  }
  return found[0]!;
}

/** The customer's address the row names by its street, or their only or main one when it names none. */
async function propertyFor(
  tx: Database, customer: { id: string; name: string }, street: string | undefined,
): Promise<string> {
  const places = await tx.select({ id: schema.property.id, line1: schema.property.addressLine1 })
    .from(schema.customerProperty)
    .innerJoin(schema.property, eq(schema.property.id, schema.customerProperty.propertyId))
    .where(and(
      eq(schema.customerProperty.customerId, customer.id),
      isNull(schema.customerProperty.endedOn),
      isNull(schema.property.deletedAt),
    ))
    .orderBy(desc(schema.customerProperty.isPrimary), asc(schema.customerProperty.createdAt));
  const plain = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (street !== undefined) {
    const match = places.find((p) => plain(p.line1 ?? "") === plain(street));
    if (!match) throw new ConflictError(`${customer.name} has no address at ${street}.`);
    return match.id;
  }
  if (places.length === 0) throw new ConflictError(`${customer.name} has no address on file, and it needs one.`);
  return places[0]!.id;
}

/** A job by the id a jobs file gave it, or by the number it kept. */
async function jobFor(tx: Database, source: string, ref: string): Promise<string> {
  const [byRef] = await tx.select({ id: schema.job.id }).from(schema.job)
    .where(byExternal(schema.job, { externalSource: source, externalId: ref })).limit(1);
  if (byRef) return byRef.id;
  if (/^\d{1,10}$/.test(ref)) {
    const [byNumber] = await tx.select({ id: schema.job.id }).from(schema.job)
      .where(eq(schema.job.number, Number(ref))).limit(1);
    if (byNumber) return byNumber.id;
  }
  throw new ConflictError(`There is no job ${ref}. Bring in the jobs file first, or clear the job column.`);
}

/**
 * The technician a visit names, by the email they sign in with, among the
 * people on the board: an active technician of this company. Never by name,
 * for the reason a customer is never found by name, and never somebody who
 * is not on the board, because a visit put on nobody, or on somebody who has
 * since left and whom nobody can see, is worse than a row refused.
 */
async function technicianFor(tx: Database, email: string): Promise<{ id: string; name: string }> {
  const found = await tx.execute<{ id: string; name: string }>(sql`
    select t.id, t.display_name as name from public.technician t
    join app.organization_people() p on p.membership_id = t.membership_id
    where lower(p.email) = lower(${email}) and t.active`);
  const rows = [...found];
  if (rows.length === 0) {
    throw new ConflictError(
      `Nobody on the board signs in with ${email}. Add them as a technician under Team first, `
      + "or put the email they sign in with.",
    );
  }
  if (rows.length > 1) throw new ConflictError(`More than one technician signs in with ${email}.`);
  return rows[0]!;
}

/** A number another system printed, kept when it is one this product can keep. */
const keptNumber = (value: string | undefined): number | undefined =>
  value !== undefined && /^\d{1,10}$/.test(value) && Number(value) >= 1 && Number(value) <= 2_000_000_000
    ? Number(value) : undefined;

/**
 * ONE ROW, THROUGH THE API'S OWN CREATE.
 *
 * The input is built from the row, parsed by the route's schema (so its
 * defaults and limits apply exactly as over HTTP) and handed to the route's
 * service. Throws a refusal; returns what the row became.
 */
async function loadOne(
  db: Database, ctx: ServiceContext, run: Run, row: Pending, clock: { today: string; timeZone: string },
): Promise<{ outcome: "loaded" | "already"; recordId: string; recordLabel: string }> {
  const kind = kindOf(run);
  const read = rules.readRow(kind, run.columns, row.cells, { dayFirst: run.dayFirst, today: clock.today });
  /** A record of several rows, or a payment, is read together; anything else is the one row. */
  const together = rules.isGrouped(kind)
    ? readTogether(kind, run, [{ rowNumber: row.rowNumber, cells: row.cells }, ...row.parts], clock.today)
    : null;
  const problems = together ? together.problems : read.problems;
  if (problems.length > 0) throw new ConflictError(problems.join(" "));
  const v = together ? together.values : read.values;
  const key = row.sourceKey ?? rules.naturalKey(kind, v) ?? rowHash(read.values);
  const externalRef = { source: run.source, id: key };
  const as = rowContext(ctx, db, run);

  const existing = await claimed(db, kind, run.source, key);
  if (existing) {
    return { outcome: "already", recordId: existing, recordLabel: await labelOf(db, kind, existing) };
  }

  switch (kind) {
    case "customers": {
      const address = v["street"] !== undefined
        ? {
            line1: v["street"], ...(v["street2"] ? { line2: v["street2"] } : {}),
            city: v["city"], state: v["state"], postalCode: v["zip"],
          }
        : undefined;
      const input = CustomerCreate.parse({
        type: v["type"] ?? "residential",
        name: v["name"],
        ...(v["email"] ? { email: v["email"] } : {}),
        ...(v["phone"] ? { phone: v["phone"] } : {}),
        ...(address ? { billingAddress: address, property: { address } } : {}),
        tags: v["tags"] ? v["tags"].split(/[;,]/).map((t) => t.trim()).filter((t) => t !== "") : [],
        ...(v["leadSource"] ? { leadSource: v["leadSource"] } : {}),
        externalRef,
      });
      const customer = await customers.create(as, input);
      if (v["contactName"]) {
        await contacts.create(as, {
          customerId: customer.id,
          name: v["contactName"],
          email: v["contactEmail"] ?? null,
          phone: v["contactPhone"] ?? null,
          title: v["contactTitle"] ?? null,
          preferredChannel: v["contactPhone"] ? "sms" : "email",
          isPrimary: true,
        });
      }
      return { outcome: "loaded", recordId: customer.id, recordLabel: `Customer ${customer.name}` };
    }

    case "equipment": {
      const customer = await customerFor(db, run.source, v);
      const propertyId = await propertyFor(db, customer, v["street"]);
      const input = registerEquipment.input.parse({
        propertyId,
        category: v["category"],
        ...(v["manufacturer"] ? { manufacturer: v["manufacturer"] } : {}),
        ...(v["model"] ? { model: v["model"] } : {}),
        ...(v["serial"] ? { serialNumber: v["serial"] } : {}),
        ...(v["installedOn"] ? { installedOn: v["installedOn"] } : {}),
        ...(v["warrantyParts"] ? { warrantyPartsExpiresOn: v["warrantyParts"] } : {}),
        ...(v["warrantyLabor"] ? { warrantyLaborExpiresOn: v["warrantyLabor"] } : {}),
        ...(v["tag"] ? { tag: v["tag"] } : {}),
        ...(v["location"] ? { location: v["location"] } : {}),
        externalRef,
      });
      const unit = await equipment.register(as, input);
      return { outcome: "loaded", recordId: unit.id, recordLabel: unitLabel(unit.category, unit.serialNumber, customer.name) };
    }

    case "pricebook": {
      const input = createPriceBookItem.input.parse({
        kind: v["kind"] ?? "service",
        code: v["code"],
        name: v["name"],
        ...(v["description"] ? { description: v["description"] } : {}),
        price: v["price"],
        ...(v["cost"] ? { cost: v["cost"] } : {}),
        ...(v["taxable"] !== undefined ? { taxable: v["taxable"] === "true" } : {}),
        externalRef,
      });
      const item = await pricebook.create(as, input);
      return { outcome: "loaded", recordId: item.id, recordLabel: `Item ${input.code}` };
    }

    case "jobs": {
      const customer = await customerFor(db, run.source, v);
      const propertyId = await propertyFor(db, customer, v["street"]);
      const number = keptNumber(v["number"]);
      const status = v["status"];
      if (status === "cancelled" && v["finishedOn"] === undefined) {
        throw new ConflictError("It says it was cancelled and not when. Fill in the day in the Finished on column.");
      }
      const ended = v["finishedOn"] !== undefined ? instantOf(v["finishedOn"], clock.today, clock.timeZone) : undefined;
      const note = number === undefined && v["number"] !== undefined ? `Numbered ${v["number"]} before.` : undefined;
      const input = JobCreate.parse({
        ...(number !== undefined ? { number } : {}),
        externalRef,
        customerId: customer.id,
        propertyId,
        summary: v["summary"],
        ...(v["description"] || note ? { description: [note, v["description"]].filter(Boolean).join("\n") } : {}),
        ...(status === "completed" ? { completedAt: ended } : {}),
        ...(status === "cancelled" ? { cancelledAt: ended } : {}),
      });
      const job = await jobs.create(as, input);
      return { outcome: "loaded", recordId: job.id, recordLabel: `Job ${job.number}` };
    }

    case "invoices": {
      const customer = await customerFor(db, run.source, v);
      const jobId = v["jobRef"] !== undefined ? await jobFor(db, run.source, v["jobRef"]) : undefined;
      const number = keptNumber(v["number"]);
      const input = createInvoice.input.parse({
        ...(number !== undefined ? { number } : {}),
        externalRef,
        customerId: customer.id,
        ...(jobId ? { jobId } : {}),
        issuedOn: v["issuedOn"],
        ...(v["dueOn"] ? { dueOn: v["dueOn"] } : {}),
        ...(number === undefined && v["number"] !== undefined ? { memo: `Numbered ${v["number"]} before.` } : {}),
        /**
         * One line per row, each at its quantity and price each (or one at
         * its amount before tax), with the tax that row says was charged on
         * it. The rate is what that tax was charged at, and the invoice
         * checks the two agree to within a cent, line by line.
         */
        lines: together!.lines.map((line) => {
          const taxed = !m.isZero(m.money(line.tax));
          return {
            name: line.name,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            taxable: taxed,
            ...(taxed ? { taxRate: rules.taxRateOf(line.tax, line.subtotal), taxAmount: line.tax } : {}),
          };
        }),
        expectedTotals: { total: v["total"] },
      });
      const invoice = await billing.create(as, input);
      const paid = v["paid"];
      let said = `Invoice ${invoice.number}${together!.lines.length > 1 ? `, ${together!.lines.length} lines` : ""}`;
      if (paid !== undefined && m.isPositive(m.money(paid))) {
        await billing.pay(as, recordPayment.input.parse({
          externalRef: { source: run.source, id: `${key}/payment` },
          customerId: customer.id,
          method: v["method"] ?? "other",
          amount: paid,
          receivedAt: instantOf(v["paidOn"]!, clock.today, clock.timeZone),
          allocations: [{ invoiceId: invoice.id, amount: paid }],
        }));
        said += `, ${rules.trimMoney(paid)} paid`;
      }
      return { outcome: "loaded", recordId: invoice.id, recordLabel: said };
    }

    case "estimates": {
      /**
       * AN ESTIMATE AS IT ARRIVED: its options, each with its lines, taxed at
       * the rate its tax was charged at (never the company's rate of today),
       * with how it ended and the day it was sent recorded through the
       * create's own history fields, which emit nothing and record no
       * signature. The option the customer chose is the one the file names and
       * is never guessed. What each option comes to is checked against the
       * file's afterwards, so a cent of rounding is a refusal in words rather
       * than a quote that disagrees with the customer's copy.
       */
      const customer = await customerFor(db, run.source, v);
      const propertyId = await propertyFor(db, customer, v["street"]);
      const jobId = v["jobRef"] !== undefined ? await jobFor(db, run.source, v["jobRef"]) : undefined;
      const number = keptNumber(v["number"]);
      const group = together!;
      const tax = rules.estimateTax(group.options);
      const outcome = v["outcome"] as "approved" | "declined" | "expired" | "open";
      const title = v["title"] ?? (number === undefined && v["number"] !== undefined ? `Numbered ${v["number"]} before` : undefined);
      const input = createEstimate.input.parse({
        ...(number !== undefined ? { number } : {}),
        externalRef,
        customerId: customer.id,
        propertyId,
        ...(jobId ? { jobId } : {}),
        ...(title ? { title } : {}),
        issuedOn: v["issuedOn"],
        ...(tax.rate !== null ? { taxRate: tax.rate } : { taxRateId: null }),
        options: group.options.map((option, o) => ({
          name: option.name,
          isRecommended: option.recommended,
          lines: option.lines.map((line, l) => {
            const own = tax.lineRates[o]?.[l];
            return {
              name: line.name,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              taxable: !m.isZero(m.money(line.tax)),
              ...(own ? { taxRate: own } : {}),
            };
          }),
        })),
        ...(outcome !== "open" ? {
          outcome: {
            status: outcome, on: v["decidedOn"],
            ...(outcome === "approved" ? { chosenOption: group.options.findIndex((option) => option.chosen) } : {}),
            ...(outcome === "declined" && v["reason"] ? { reason: v["reason"] } : {}),
          },
        } : {}),
        ...(v["sentOn"] ? { sentOn: v["sentOn"] } : {}),
      });
      const estimate = await estimates.create(as, input);
      for (const option of group.options) {
        const made = estimate.options.find((o) => o.name === option.name);
        const total = made?.total ?? "0";
        if (m.compare(m.money(total), m.money(option.total)) !== 0) {
          throw new ConflictError(
            `${group.options.length === 1 ? "Written here it" : `The option "${option.name}" written here`} comes to ${rules.trimMoney(m.toString(m.money(total)))}, `
            + `not the ${rules.trimMoney(option.total)} in the file. Check its tax: an estimate's tax is worked out from its rate.`,
          );
        }
      }
      const how = outcome === "open" ? "open, to send from here" : outcome;
      const many = group.options.length > 1 ? `${group.options.length} options, ` : "";
      return { outcome: "loaded", recordId: estimate.id, recordLabel: `Estimate ${estimate.number}, ${many}${how}` };
    }

    case "notes": {
      /**
       * A NOTE ON THE DAY THE FILE SAYS, through `POST /v1/customers/{id}/notes`:
       * marked as brought in, with nobody here as its writer, never changed
       * afterwards, and shown to the technician only when the file says so.
       */
      const customer = await customerFor(db, run.source, v);
      const note = await customerNotes.add(as, addCustomerNote.input.parse({
        id: customer.id,
        body: v["body"],
        notedAt: instantOf(v["notedOn"]!, clock.today, clock.timeZone),
        ...(v["forField"] !== undefined ? { forField: v["forField"] === "true" } : {}),
        externalRef,
      }));
      return { outcome: "loaded", recordId: note.id, recordLabel: `Note on ${customer.name}` };
    }

    case "visits": {
      /**
       * A VISIT ON A JOB THAT IS OVER, AS IT HAPPENED, through
       * `POST /v1/jobs/{id}/visits` with `completedAt`: on the day and at the
       * time in the file on the company's clock, done, by the technician whose
       * email it names. History, so it raises no event, tells nobody, is not
       * refused for time off recorded later, and is kept out of every
       * commission split and tip share. With no time it finished, it is an
       * hour long, which is the length a visit is booked for when nobody says.
       */
      const jobId = await jobFor(db, run.source, v["jobRef"]!);
      const technician = await technicianFor(db, v["technicianEmail"]!);
      const start = time.instantOfLocal(v["visitedOn"]!, rules.minutesOf(v["startTime"]!), clock.timeZone);
      const end = v["endTime"] !== undefined
        ? time.instantOfLocal(v["visitedOn"]!, rules.minutesOf(v["endTime"]), clock.timeZone)
        : new Date(start.getTime() + 60 * 60_000);
      const minutes = Math.min(1440, Math.max(5, Math.round((end.getTime() - start.getTime()) / 60_000)));
      const visit = await jobs.addVisit(as, scheduleVisit.input.parse({
        id: jobId,
        windowStart: start.toISOString(),
        windowEnd: end.toISOString(),
        estimatedDurationMinutes: minutes,
        technicianIds: [technician.id],
        completedAt: end.toISOString(),
        ...(v["notes"] ? { technicianNotes: v["notes"] } : {}),
        externalRef,
      }), { requireFields: true });
      const [job] = await db.select({ number: schema.job.number }).from(schema.job).where(eq(schema.job.id, jobId)).limit(1);
      return { outcome: "loaded", recordId: visit.id, recordLabel: `Visit on job ${job?.number ?? ""} by ${technician.name}` };
    }

    case "payments": {
      /**
       * ONE PAYMENT, ON EVERY INVOICE ITS ROWS NAME. Each invoice is found
       * the way an invoice finds its job: by the id an invoices file gave it
       * under the same "came from" name, or by the number it kept. A row
       * naming no invoice is money held for the customer, applied to
       * nothing, which is what the payment create does with it.
       */
      const allocations: Array<{ invoiceId: string; amount: string }> = [];
      let owner: { id: string; name: string } | null = null;
      for (const share of together!.allocations) {
        if (share.invoiceRef === null) continue;
        const invoice = await invoiceFor(db, run.source, share.invoiceRef);
        allocations.push({ invoiceId: invoice.id, amount: share.amount });
        owner ??= { id: invoice.customerId, name: invoice.customerName };
      }
      const named = v["customerRef"] !== undefined || v["customerEmail"] !== undefined ? await customerFor(db, run.source, v) : null;
      const customer = named ?? owner;
      if (!customer) throw new ConflictError("Neither the invoice nor the customer is filled in, so there is no telling whose money it is.");
      const payment = await billing.pay(as, recordPayment.input.parse({
        externalRef,
        customerId: customer.id,
        method: v["method"] ?? "other",
        amount: v["amount"],
        receivedAt: instantOf(v["paidOn"]!, clock.today, clock.timeZone),
        allocations,
        ...(v["checkNumber"] ? { checkNumber: v["checkNumber"] } : {}),
        ...(v["memo"] ? { notes: v["memo"] } : {}),
      }));
      const on = allocations.length === 0 ? "held for them" : allocations.length === 1 ? "on 1 invoice" : `on ${allocations.length} invoices`;
      return { outcome: "loaded", recordId: payment.id, recordLabel: `Payment of ${rules.trimMoney(v["amount"]!)} from ${customer.name}, ${on}` };
    }
  }
}

/** An invoice by the id an invoices file gave it, or by the number it kept. */
async function invoiceFor(tx: Database, source: string, ref: string): Promise<{ id: string; customerId: string; customerName: string }> {
  const fields = {
    id: schema.invoice.id, customerId: schema.invoice.customerId, customerName: schema.customer.name,
  };
  const [byRef] = await tx.select(fields).from(schema.invoice)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.invoice.customerId))
    .where(byExternal(schema.invoice, { externalSource: source, externalId: ref })).limit(1);
  if (byRef) return byRef;
  const number = keptNumber(ref.replace(/^#/, ""));
  if (number !== undefined) {
    const [byNumber] = await tx.select(fields).from(schema.invoice)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.invoice.customerId))
      .where(eq(schema.invoice.number, number)).limit(1);
    if (byNumber) return byNumber;
  }
  throw new ConflictError(`There is no invoice ${ref}. Bring in the invoices file first, under the same name for where it came from.`);
}

function unitLabel(category: string, serial: string | null, customer?: string): string {
  return `${category}${serial ? ` ${serial}` : ""}${customer ? ` for ${customer}` : ""}`;
}

/** What a record already here is called, for "already brought in as ...". */
async function labelOf(tx: Database, kind: Kind, id: string): Promise<string> {
  switch (kind) {
    case "customers": {
      const [row] = await tx.select({ name: schema.customer.name }).from(schema.customer).where(eq(schema.customer.id, id)).limit(1);
      return `Customer ${row?.name ?? ""}`.trim();
    }
    case "equipment": {
      const [row] = await tx.select({ category: schema.equipment.category, serial: schema.equipment.serialNumber })
        .from(schema.equipment).where(eq(schema.equipment.id, id)).limit(1);
      return row ? unitLabel(row.category, row.serial) : "A unit";
    }
    case "pricebook": {
      const [row] = await tx.select({ code: schema.priceBookItem.code }).from(schema.priceBookItem).where(eq(schema.priceBookItem.id, id)).limit(1);
      return `Item ${row?.code ?? ""}`.trim();
    }
    case "jobs": {
      const [row] = await tx.select({ number: schema.job.number }).from(schema.job).where(eq(schema.job.id, id)).limit(1);
      return `Job ${row?.number ?? ""}`.trim();
    }
    case "invoices": {
      const [row] = await tx.select({ number: schema.invoice.number }).from(schema.invoice).where(eq(schema.invoice.id, id)).limit(1);
      return `Invoice ${row?.number ?? ""}`.trim();
    }
    case "estimates": {
      const [row] = await tx.select({ number: schema.estimate.number }).from(schema.estimate).where(eq(schema.estimate.id, id)).limit(1);
      return `Estimate ${row?.number ?? ""}`.trim();
    }
    case "notes": {
      const [row] = await tx.select({ name: schema.customer.name }).from(schema.customerNote)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.customerNote.customerId))
        .where(eq(schema.customerNote.id, id)).limit(1);
      return row ? `Note on ${row.name}` : "A note";
    }
    case "visits": {
      const [row] = await tx.select({ number: schema.job.number, sequence: schema.visit.sequence }).from(schema.visit)
        .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
        .where(eq(schema.visit.id, id)).limit(1);
      return row ? `Visit ${row.sequence} on job ${row.number}` : "A visit";
    }
    case "payments": {
      const [row] = await tx.select({ amount: schema.payment.amount, name: schema.customer.name }).from(schema.payment)
        .innerJoin(schema.customer, eq(schema.customer.id, schema.payment.customerId))
        .where(eq(schema.payment.id, id)).limit(1);
      return row ? `Payment of ${rules.trimMoney(String(row.amount))} from ${row.name}` : "A payment";
    }
  }
}

/** One row inside its own savepoint and the company's tenant, refused in words or thrown as a bug. */
async function tryRow(
  ctx: ServiceContext, db: Database, run: Run, row: Pending, clock: { today: string; timeZone: string },
): Promise<RowResult> {
  try {
    const done = await inTenant(rowContext(ctx, db, run), (sp) => loadOne(sp, ctx, run, row, clock));
    return { id: row.id, outcome: done.outcome, reason: null, recordId: done.recordId, recordLabel: done.recordLabel };
  } catch (error) {
    const said = refusalOf(error);
    if (said === null) throw error;
    return { id: row.id, outcome: "refused", reason: said, recordId: null, recordLabel: null };
  }
}

async function writeOutcomes(tx: Database, results: readonly RowResult[]): Promise<void> {
  for (let i = 0; i < results.length; i += 1000) {
    const chunk = results.slice(i, i + 1000);
    if (chunk.length === 0) continue;
    await tx.execute(sql`
      update public.import_row r
      set outcome = v.outcome, reason = v.reason, record_id = v.record_id, record_label = v.record_label, updated_at = now()
      from unnest(
        ${sql.param(chunk.map((r) => r.id))}::uuid[],
        ${sql.param(chunk.map((r) => r.outcome))}::text[],
        ${sql.param(chunk.map((r) => r.reason))}::text[],
        ${sql.param(chunk.map((r) => r.recordId))}::uuid[],
        ${sql.param(chunk.map((r) => r.recordLabel))}::text[]
      ) as v(id, outcome, reason, record_id, record_label)
      where r.id = v.id`);
    /** The rest of each record's rows take the outcome of the row that loaded them. */
    await tx.execute(sql`
      update public.import_row f
      set outcome = h.outcome, reason = h.reason, record_id = h.record_id, record_label = h.record_label, updated_at = now()
      from public.import_row h
      where h.id = any(${sql.param(chunk.map((r) => r.id))}::uuid[])
        and f.run_id = h.run_id and f.part_of = h.row_number`);
  }
}

function assertKind(ctx: ServiceContext, kind: Kind): void {
  for (const permission of NEEDS[kind]) assertCan(ctx.actor, permission);
}

async function progress(tx: Database, run: Run, tried: number, more: (counts: Record<Outcome, number>) => boolean) {
  const counts = (await countsOf(tx, [run.id])).get(run.id)!;
  return {
    id: run.id,
    status: run.status as "mapping" | "checking" | "checked" | "loading" | "finished",
    rows: run.rowCount,
    counts,
    tried,
    more: more(counts),
  };
}

type Progress = Awaited<ReturnType<typeof progress>>;

async function nextRows(tx: Database, runId: string, outcome: Outcome): Promise<Pending[]> {
  /** Only the first row of each record is tried; it carries the rest. */
  const heads = await tx.select({
    id: schema.importRow.id, rowNumber: schema.importRow.rowNumber,
    cells: schema.importRow.cells, sourceKey: schema.importRow.sourceKey,
  }).from(schema.importRow)
    .where(and(eq(schema.importRow.runId, runId), eq(schema.importRow.outcome, outcome), isNull(schema.importRow.partOf)))
    .orderBy(asc(schema.importRow.rowNumber)).limit(rules.BATCH_SIZE);
  if (heads.length === 0) return [];
  const parts = await tx.select({
    partOf: schema.importRow.partOf, rowNumber: schema.importRow.rowNumber, cells: schema.importRow.cells,
  }).from(schema.importRow)
    .where(and(eq(schema.importRow.runId, runId), inArray(schema.importRow.partOf, heads.map((h) => h.rowNumber))))
    .orderBy(asc(schema.importRow.rowNumber));
  return heads.map((head) => ({
    ...head,
    parts: parts.filter((p) => p.partOf === head.rowNumber).map((p) => ({ rowNumber: p.rowNumber, cells: p.cells })),
  }));
}

/* ------------------------------------------------------------------ check */

/**
 * THE DRY RUN, A BATCH AT A TIME.
 *
 * The next batch of rows nobody has tried goes through `loadOne` inside
 * `dryRun`, which runs it and rolls it back, and each row is in a savepoint of
 * its own so the second refusal in a batch is found as well as the first.
 * What each row WOULD do is then written, in a transaction of its own after
 * the rollback, because the answers are the one thing a check keeps.
 */
export async function check(ctx: ServiceContext, input: { id: string }): Promise<Progress> {
  assertCan(ctx.actor, "data:import");
  const before = await inTenant(ctx, async (tx) => {
    const again = await replayed<Progress>(tx, ctx, "import_check");
    if (again) return { replay: true as const, again };
    const run = await loadRun(tx, input.id);
    if (run.status !== "mapping" && run.status !== "checking") {
      throw new ConflictError(run.status === "checked"
        ? "This file has been checked. Load it, or change its columns to check it again."
        : "Rows from this file are already loaded, so there is nothing left to check.");
    }
    const problems = problemsOf(run);
    if (problems.length > 0) throw new ConflictError(`Set the columns first. ${problems.join(" ")}`);
    return { replay: false as const, run, rows: await nextRows(tx, run.id, "waiting"), clock: await todayFor(tx, ctx) };
  });
  if (before.replay) return before.again;
  const { run, rows, clock } = before;
  assertKind(ctx, kindOf(run));

  let results: RowResult[] = [];
  if (rows.length > 0) {
    const report = await dryRun(ctx, async (inner) => {
      const out: RowResult[] = [];
      for (const row of rows) out.push(await tryRow(ctx, inner.db, run, row, clock));
      return out;
    });
    /** What would have loaded is ready, and points at nothing: the record it made was rolled back. */
    results = (report.wouldReturn as RowResult[])
      .map((r) => (r.outcome === "loaded" ? { ...r, outcome: "ready" as const, recordId: null } : r));
  }

  return guardedWrite(ctx, "data:import", async (tx) => {
    await writeOutcomes(tx, results);
    const [left] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.importRow)
      .where(and(eq(schema.importRow.runId, run.id), eq(schema.importRow.outcome, "waiting")));
    const done = Number(left?.n ?? 0) === 0;
    const [updated] = await tx.update(schema.importRun).set({
      status: done ? "checked" : "checking",
      ...(done ? { checkedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.importRun.id, run.id)).returning();
    if (!updated) throw new NotFoundError("Spreadsheet");
    const answer = await progress(tx, updated, rows.length, (c) => c.waiting > 0);
    if (done) await audit(tx, ctx, "import.checked", "import_run", run.id, null, answer.counts);
    await remember(tx, ctx, "import_check", run.id, answer);
    return answer;
  });
}

/* ------------------------------------------------------------------- load */

/**
 * THE NEXT BATCH, FOR REAL, WHOLE OR NOT AT ALL.
 *
 * The batch's rows go through `loadOne` in one transaction, and their
 * answers are written in it too, so the rows and the records they became
 * commit together. When a row is refused now (somebody added the same
 * invoice by hand since the check, or closed the period), the transaction is
 * rolled back, that row is marked refused with its reason, and the rest of
 * the batch is tried again without it. A batch is never half in.
 */
export async function load(ctx: ServiceContext, input: { id: string }): Promise<Progress> {
  assertCan(ctx.actor, "data:import");
  const before = await inTenant(ctx, async (tx) => {
    const again = await replayed<Progress>(tx, ctx, "import_load");
    if (again) return { replay: true as const, again };
    const run = await loadRun(tx, input.id);
    if (run.status !== "checked" && run.status !== "loading" && run.status !== "finished") {
      throw new ConflictError("Check the file first. Every row is tried before any is loaded.");
    }
    return { replay: false as const, run, rows: await nextRows(tx, run.id, "ready"), clock: await todayFor(tx, ctx) };
  });
  if (before.replay) return before.again;
  const { run, clock } = before;
  assertKind(ctx, kindOf(run));

  let batch = before.rows;
  const refusedNow: RowResult[] = [];
  const finish = async (tx: Database, results: RowResult[]): Promise<Progress> => {
    await writeOutcomes(tx, [...results, ...refusedNow]);
    const [left] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.importRow)
      .where(and(eq(schema.importRow.runId, run.id), eq(schema.importRow.outcome, "ready")));
    const done = Number(left?.n ?? 0) === 0;
    const [updated] = await tx.update(schema.importRun).set({
      status: done ? "finished" : "loading",
      ...(done && run.finishedAt === null ? { finishedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.importRun.id, run.id)).returning();
    /** Forgotten while this batch was going in: the batch is rolled back with it, so nothing is loaded from a file that is gone. */
    if (!updated) throw new NotFoundError("Spreadsheet");
    const answer = await progress(tx, updated, before.rows.length, (c) => c.ready > 0);
    if (results.length + refusedNow.length > 0) {
      await audit(tx, ctx, "import.batch_loaded", "import_run", run.id, null, {
        loaded: results.filter((r) => r.outcome === "loaded").length,
        already: results.filter((r) => r.outcome === "already").length,
        refused: refusedNow.length,
      });
    }
    await remember(tx, ctx, "import_load", run.id, answer);
    return answer;
  };

  for (;;) {
    if (batch.length === 0) return guardedWrite(ctx, "data:import", (tx) => finish(tx, []));
    const attempt = batch;
    try {
      return await inTenant(ctx, async (tx) => {
        const results: RowResult[] = [];
        for (const [index, row] of attempt.entries()) {
          try {
            const done = await inTenant(rowContext(ctx, tx, run), (sp) => loadOne(sp, ctx, run, row, clock));
            results.push({ id: row.id, outcome: done.outcome, reason: null, recordId: done.recordId, recordLabel: done.recordLabel });
          } catch (error) {
            const said = refusalOf(error);
            if (said === null) throw error;
            throw new RowRefused(index, said);
          }
        }
        return finish(tx, results);
      });
    } catch (error) {
      if (!(error instanceof RowRefused)) throw error;
      const row = attempt[error.index]!;
      refusedNow.push({ id: row.id, outcome: "refused", reason: error.reason, recordId: null, recordLabel: null });
      batch = attempt.filter((_, i) => i !== error.index);
    }
  }
}

/* ------------------------------------------------------------ the refusals */

export async function refusedFile(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "data:import", async (tx) => {
    const run = await loadRun(tx, input.id);
    const rows = await tx.select({ row: schema.importRow.rowNumber, cells: schema.importRow.cells, reason: schema.importRow.reason })
      .from(schema.importRow)
      .where(and(eq(schema.importRow.runId, run.id), eq(schema.importRow.outcome, "refused")))
      .orderBy(asc(schema.importRow.rowNumber));
    const base = run.fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "spreadsheet";
    const sheet = (run.sheetName ?? "").replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    return {
      fileName: `${base}${sheet ? `-${sheet}` : ""}-refused.csv`,
      rows: rows.length,
      csv: rules.refusedCsv(run.header, rows.map((r) => ({ row: r.row, cells: r.cells, reason: r.reason ?? "" }))),
    };
  });
}

/* ----------------------------------------------------------- forgetting */

/**
 * FORGET A FILE: the file and its rows go, and what it made stays.
 *
 * A file is kept after it is loaded so the screen can show what happened, and
 * keeping it for ever is a customer list sitting in a table nobody can empty.
 * Forgetting removes the file, every row of it (so the cells, which are
 * personal data, go with it), the refused rows that could be downloaded, and
 * nothing else. A record it loaded is not touched: it is an ordinary record
 * now, with its `externalRef`, which is also what makes the same file brought in
 * again skip it rather than load it twice.
 *
 * `ran` is whether the file was ever loaded, and the screen says which of the
 * two it is about to do before it does it. The run is locked first, so a batch
 * in flight finishes (and its records are counted) before the file goes, and a
 * batch that starts after is told the file is not there.
 *
 * WHAT A FORGOTTEN FILE LEAVES BEHIND IS A HOLD. The events its records raised
 * name the file (`domain_event.import_run_id`) and the workflow engine reads
 * the file's switch through that name. With the file gone, the engine treats an
 * event from a file it cannot find as held (workflow-runner.ts): forgetting a
 * file must never turn automations back on for the people on it.
 */
export async function forget(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "data:import", async (tx) => {
    const run = await loadRun(tx, input.id);
    await tx.execute(sql`select 1 from public.import_run where id = ${run.id} for update`);
    const counts = (await countsOf(tx, [run.id])).get(run.id)!;
    const ran = run.status === "loading" || run.status === "finished" || counts.loaded > 0;
    await tx.delete(schema.importRun).where(eq(schema.importRun.id, run.id));
    await audit(tx, ctx, "import.forgotten", "import_run", run.id,
      {
        kind: run.kind, fileName: run.fileName, sheetName: run.sheetName, source: run.source, status: run.status,
        rows: run.rowCount, ran, loaded: counts.loaded,
      },
      null);
    return { id: run.id, removed: true as const, ran, rows: run.rowCount, loaded: counts.loaded };
  });
}

/* --------------------------------------------------------------- mappings */

export async function mappings(ctx: ServiceContext) {
  return guardedRead(ctx, "data:import", async (tx) => {
    const rows = await tx.select().from(schema.importMapping)
      .orderBy(asc(schema.importMapping.kind), asc(schema.importMapping.name));
    return {
      mappings: rows.filter((r) => rules.isImportKind(r.kind)).map((r) => ({
        id: r.id, kind: r.kind as Kind, name: r.name, source: r.source, dayFirst: r.dayFirst,
        columns: r.columns, updatedAt: r.updatedAt.toISOString(),
      })),
    };
  });
}

export async function removeMapping(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "data:import", async (tx) => {
    const [gone] = await tx.delete(schema.importMapping).where(eq(schema.importMapping.id, input.id)).returning();
    if (!gone) throw new NotFoundError("Saved mapping");
    await audit(tx, ctx, "import.mapping_removed", "import_mapping", gone.id, gone, null);
    return { id: gone.id, removed: true as const };
  });
}

export const handlers = {
  listImports: (ctx: ServiceContext) => list(ctx),
  startImport: (
    ctx: ServiceContext,
    input: {
      kind: Kind; fileName: string; csv?: string | undefined; workbook?: string | undefined; sheet?: string | undefined;
      holdAutomations?: boolean | undefined;
    },
  ) => start(ctx, input),
  listImportSheets: (ctx: ServiceContext, input: { workbook: string }) => sheets(ctx, input),
  getImport: (ctx: ServiceContext, input: { id: string }) => get(ctx, input),
  forgetImport: (ctx: ServiceContext, input: { id: string }) => forget(ctx, input),
  mapImport: (
    ctx: ServiceContext,
    input: {
      id: string; columns: Array<string | null>; source: string; dayFirst: boolean; saveAs?: string | undefined;
      holdAutomations?: boolean | undefined;
    },
  ) => map(ctx, input),
  checkImport: (ctx: ServiceContext, input: { id: string }) => check(ctx, input),
  loadImport: (ctx: ServiceContext, input: { id: string }) => load(ctx, input),
  getImportRefusals: (ctx: ServiceContext, input: { id: string }) => refusedFile(ctx, input),
  listImportMappings: (ctx: ServiceContext) => mappings(ctx),
  deleteImportMapping: (ctx: ServiceContext, input: { id: string }) => removeMapping(ctx, input),
} as const;
