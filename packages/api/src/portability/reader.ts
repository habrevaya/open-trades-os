import { createReadStream } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { portability } from "@opentradesos/core";
import type { Manifest } from "../services/export";
import { readDirectory, readEntry, readWhole, ZipError, type ZipEntry } from "./zip";

/**
 * READING A COPY BACK, WHICHEVER SHAPE IT IS IN
 *
 * A restore takes either file this product writes: the newline delimited one
 * or the zip of spreadsheets. Both are read from a file on disk rather than
 * from memory, because a company with years of history is gigabytes, and the
 * restore has to read each table when its turn comes in load order rather than
 * in the order the file happens to hold them.
 *
 * So opening a copy reads its index and nothing more: the manifest, where each
 * table's rows are, which files it carries and whether it says it is complete.
 * Rows and file bytes are read later, a table or a file at a time.
 */

/** The largest single file a copy may say it carries. Far above any photograph or recording here. */
const MAX_FILE_BYTES = 512 * 1024 * 1024;
/** The largest manifest a copy may carry. A manifest is a few hundred kilobytes. */
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
/** Rows handed to the restore at a time. */
export const ROW_BATCH = 500;

export interface CarriedFile {
  storageKey: string;
  sha256: string | null;
  sizeBytes: number | null;
}

export interface Copy {
  format: "ndjson" | "archive";
  manifest: Manifest;
  /** What the copy's last line or last entry says was written; null when it has none, which means it was cut short. */
  complete: { rows: number; files: number } | null;
  /**
   * The column names the copy holds for a table, in its own order. For the
   * archive these are the CSV's header; for the other format they are the
   * manifest's, since each row names its own.
   */
  columnsOf(table: string): Promise<string[] | null>;
  /**
   * A table's rows, in batches. `textual` says every value is a string as
   * Postgres writes it (the CSV), so the restore knows to read jsonb back from
   * its text.
   */
  rows(table: string): AsyncGenerator<{ rows: Record<string, unknown>[]; textual: boolean }>;
  /** Rows counted in the copy for a table, when that is known without reading it. */
  counted(table: string): number | null;
  files: Map<string, CarriedFile>;
  bytes(storageKey: string): Promise<Buffer>;
  close(): Promise<void>;
}

/** A copy that cannot be read, said so the person restoring knows what to do about it. */
export class CopyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopyError";
  }
}

export async function openCopy(path: string): Promise<Copy> {
  const handle = await open(path, "r");
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(4);
    await handle.read(head, 0, 4, 0);
    if (head.readUInt32LE(0) === 0x04034b50) return await openArchive(handle, size);
    if (head[0] === 0x7b) return await openNdjson(path, handle);
    throw new CopyError("This is not a copy taken from OpenTradesOS. A copy is a .zip of spreadsheets or a .ndjson file.");
  } catch (error) {
    await handle.close();
    if (error instanceof ZipError) throw new CopyError(error.message);
    throw error;
  }
}

function checkManifest(value: unknown): Manifest {
  const manifest = value as Partial<Manifest> | null;
  if (!manifest || !Array.isArray(manifest.tables) || typeof manifest.organizationId !== "string") {
    throw new CopyError("The copy's manifest is missing or is not one this product wrote.");
  }
  if (manifest.format !== undefined && manifest.format !== "opentradesos-export") {
    throw new CopyError("The copy's manifest says it is not an OpenTradesOS export.");
  }
  if (typeof manifest.version === "number" && manifest.version > 1) {
    throw new CopyError(`This copy is in format ${manifest.version}, which is newer than this version reads. Update this OpenTradesOS first.`);
  }
  /**
   * A copy taken before people, the company row and the file count were in the
   * manifest still restores; it just brings none of them back, and the report
   * says so.
   */
  return {
    format: "opentradesos-export",
    version: 1,
    company: {},
    people: [],
    files: { count: 0, bytes: 0 },
    outsideTheTenant: [],
    totalRows: 0,
    generatedAt: "",
    ...manifest,
    tables: manifest.tables.map((table) => ({
      ...table,
      apart: table.apart ?? [], columns: table.columns ?? [], redacted: table.redacted ?? [], key: table.key ?? ["id"],
    })),
  } as Manifest;
}

/* ------------------------------------------------------------ the archive */

async function openArchive(handle: FileHandle, size: number): Promise<Copy> {
  const entries = await readDirectory(handle, size);
  const manifestEntry = [...entries.values()]
    .filter((entry) => entry.name === "manifest.json" || entry.name.endsWith("/manifest.json"))
    .sort((a, b) => a.name.length - b.name.length)[0];
  if (!manifestEntry) throw new CopyError("The zip has no manifest.json, so it is not a copy taken from OpenTradesOS.");
  const prefix = manifestEntry.name.slice(0, manifestEntry.name.length - "manifest.json".length);
  const manifest = checkManifest(JSON.parse((await readWhole(handle, manifestEntry, MAX_MANIFEST_BYTES)).toString("utf8")));

  const completeEntry = entries.get(`${prefix}complete.json`);
  let complete: Copy["complete"] = null;
  if (completeEntry) {
    const said = JSON.parse((await readWhole(handle, completeEntry, 1 << 20)).toString("utf8")) as { complete?: boolean; rows?: number; files?: number };
    if (said.complete === true) complete = { rows: Number(said.rows ?? 0), files: Number(said.files ?? 0) };
  }

  const files = new Map<string, CarriedFile>();
  const fileEntries = new Map<string, ZipEntry>();
  for (const entry of entries.values()) {
    if (!entry.name.startsWith(`${prefix}files/`)) continue;
    const storageKey = entry.name.slice(`${prefix}files/`.length);
    files.set(storageKey, { storageKey, sha256: null, sizeBytes: entry.size });
    fileEntries.set(storageKey, entry);
  }

  const csvOf = (table: string) => entries.get(`${prefix}tables/${table}.csv`) ?? null;

  async function* csvRows(table: string): AsyncGenerator<(string | null)[][]> {
    const entry = csvOf(table);
    if (!entry) return;
    const reader = new portability.CsvReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for await (const chunk of readEntry(handle, entry)) {
        const rows = reader.push(decoder.decode(chunk, { stream: true }));
        if (rows.length > 0) yield rows;
      }
      const tail = reader.push(decoder.decode());
      const last = reader.end();
      if (tail.length + last.length > 0) yield [...tail, ...last];
    } catch (error) {
      if (error instanceof ZipError) throw new CopyError(error.message);
      if (error instanceof TypeError) throw new CopyError(`tables/${table}.csv is not UTF-8 text.`);
      throw new CopyError(`tables/${table}.csv could not be read: ${(error as Error).message}`);
    }
  }

  return {
    format: "archive",
    manifest,
    complete,
    async columnsOf(table) {
      for await (const rows of csvRows(table)) return (rows[0] ?? []).map((cell) => cell ?? "");
      return null;
    },
    async *rows(table) {
      let columns: string[] | null = null;
      let batch: Record<string, unknown>[] = [];
      for await (const rows of csvRows(table)) {
        for (const cells of rows) {
          if (!columns) {
            columns = cells.map((cell) => cell ?? "");
            continue;
          }
          if (cells.length !== columns.length) {
            throw new CopyError(`A row in tables/${table}.csv has ${cells.length} values and the header names ${columns.length}.`);
          }
          const row: Record<string, unknown> = {};
          for (let i = 0; i < columns.length; i++) row[columns[i]!] = cells[i];
          batch.push(row);
          if (batch.length >= ROW_BATCH) {
            yield { rows: batch, textual: true };
            batch = [];
          }
        }
      }
      if (batch.length > 0) yield { rows: batch, textual: true };
    },
    counted: () => null,
    files,
    async bytes(storageKey) {
      const entry = fileEntries.get(storageKey);
      if (!entry) throw new CopyError(`The copy does not carry the file ${storageKey}.`);
      try {
        return await readWhole(handle, entry, MAX_FILE_BYTES);
      } catch (error) {
        if (error instanceof ZipError) throw new CopyError(error.message);
        throw error;
      }
    },
    close: () => handle.close(),
  };
}

/* ------------------------------------------- the newline delimited file */

/**
 * Every line of a file with the byte it starts at, a megabyte read at a time.
 * A line is held whole once found, which for a file line is one photograph.
 */
async function* lines(path: string, start = 0, end?: number): AsyncGenerator<{ at: number; line: Buffer }> {
  const stream = createReadStream(path, { start, ...(end !== undefined ? { end: end - 1 } : {}), highWaterMark: 1 << 20 });
  let pending: Buffer[] = [];
  let pendingStart = start;
  let offset = start;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf(0x0a, from);
      if (newline < 0) break;
      const piece = chunk.subarray(from, newline);
      const line = pending.length === 0 ? piece : Buffer.concat([...pending, piece]);
      yield { at: pendingStart, line };
      pending = [];
      pendingStart = offset + newline + 1;
      from = newline + 1;
    }
    if (from < chunk.length) pending.push(chunk.subarray(from));
    offset += chunk.length;
  }
  if (pending.length > 0) {
    const line = Buffer.concat(pending);
    if (line.length > 0) yield { at: pendingStart, line };
  }
}

const TABLE_LINE = /^\{"table":"([^"\\]+)","row":/;
const BYTES_MARK = Buffer.from(",\"bytes\":\"");

async function openNdjson(path: string, handle: FileHandle): Promise<Copy> {
  let manifest: Manifest | null = null;
  let complete: Copy["complete"] = null;
  const ranges = new Map<string, { start: number; end: number }[]>();
  const counts = new Map<string, number>();
  const files = new Map<string, CarriedFile>();
  const fileAt = new Map<string, { start: number; length: number }>();
  let lineNumber = 0;
  let last: { table: string; range: { start: number; end: number } } | null = null;

  for await (const { at, line } of lines(path)) {
    lineNumber += 1;
    if (line.length === 0) continue;
    if (complete) throw new CopyError(`Line ${lineNumber} comes after the line saying the copy is complete, so the file has been changed.`);
    const head = line.subarray(0, 300).toString("utf8");
    if (lineNumber === 1) {
      if (!head.startsWith("{\"manifest\":")) throw new CopyError("The first line of a copy is its manifest, and this file's is not.");
      manifest = checkManifest((JSON.parse(line.toString("utf8")) as { manifest: unknown }).manifest);
      continue;
    }
    const table = TABLE_LINE.exec(head)?.[1];
    if (table) {
      counts.set(table, (counts.get(table) ?? 0) + 1);
      if (last && last.table === table && last.range.end === at) {
        last.range.end = at + line.length + 1;
      } else {
        const range: { start: number; end: number } = { start: at, end: at + line.length + 1 };
        ranges.set(table, [...(ranges.get(table) ?? []), range]);
        last = { table, range };
      }
      continue;
    }
    if (head.startsWith("{\"file\":")) {
      const mark = line.indexOf(BYTES_MARK);
      if (mark < 0) throw new CopyError(`Line ${lineNumber} names a file and carries no bytes for it.`);
      const described = JSON.parse(`${line.subarray(0, mark).toString("utf8")}}`) as {
        file: { storageKey: string; sha256?: string; sizeBytes?: number };
      };
      const storageKey = described.file.storageKey;
      files.set(storageKey, {
        storageKey, sha256: described.file.sha256 ?? null, sizeBytes: described.file.sizeBytes ?? null,
      });
      // The base64 runs from after the mark to before the closing `"}`.
      fileAt.set(storageKey, { start: at + mark + BYTES_MARK.length, length: line.length - mark - BYTES_MARK.length - 2 });
      continue;
    }
    if (head.startsWith("{\"complete\":")) {
      const said = JSON.parse(line.toString("utf8")) as { complete?: boolean; rows?: number; files?: number };
      if (said.complete === true) complete = { rows: Number(said.rows ?? 0), files: Number(said.files ?? 0) };
      continue;
    }
    throw new CopyError(`Line ${lineNumber} is not part of a copy: it is not a row, a file or the end.`);
  }
  if (!manifest) throw new CopyError("The file is empty.");
  const held = manifest;

  const copy: Copy = {
    format: "ndjson",
    manifest: held,
    complete,
    async columnsOf(table) {
      const described = held.tables.find((t) => t.table === table);
      if (described && described.columns.length > 0) return described.columns.map((c) => c.name);
      // An older copy without columns in its manifest: the first row names them.
      for await (const batch of copy.rows(table)) return Object.keys(batch.rows[0] ?? {});
      return null;
    },
    async *rows(table) {
      let batch: Record<string, unknown>[] = [];
      for (const range of ranges.get(table) ?? []) {
        for await (const { line } of lines(path, range.start, range.end)) {
          if (line.length === 0) continue;
          batch.push((JSON.parse(line.toString("utf8")) as { row: Record<string, unknown> }).row);
          if (batch.length >= ROW_BATCH) {
            yield { rows: batch, textual: false };
            batch = [];
          }
        }
      }
      if (batch.length > 0) yield { rows: batch, textual: false };
    },
    counted: (table) => counts.get(table) ?? 0,
    files,
    async bytes(storageKey) {
      const where = fileAt.get(storageKey);
      if (!where) throw new CopyError(`The copy does not carry the file ${storageKey}.`);
      if (where.length > MAX_FILE_BYTES * 2) throw new CopyError(`The file ${storageKey} is larger than any one file here can be.`);
      const text = Buffer.alloc(where.length);
      await handle.read(text, 0, where.length, where.start);
      return Buffer.from(text.toString("latin1"), "base64");
    },
    close: () => handle.close(),
  };
  return copy;
}
