import { inflateRawSync } from "node:zlib";
import { imports as rules } from "@opentradesos/core";

/**
 * READING A WORKBOOK (M30)
 *
 * An .xlsx is a zip of XML parts, and the library that reads it
 * (`read-excel-file`, pinned to an exact version in this package) does the
 * hard part: shared strings, styles that say a number is a date, the 1904
 * calendar. It reads the answer a spreadsheet program stored beside each
 * formula and never works one out, and it never looks at a macro: only the
 * `.xml` parts are opened, and a macro lives in a binary part that is skipped.
 *
 * WHAT THE LIBRARY DOES NOT DO IS DOUBT ITS INPUT, so this does, before it
 * is handed anything:
 *
 *   - The zip's own directory is read here and every part the library would
 *     open is opened here first, under a budget, so a small file that opens into
 *     gigabytes is refused. The directory's declared sizes are not trusted: a
 *     bomb can declare a few bytes, so each part is actually inflated with a hard
 *     ceiling on what it may come to.
 *   - The span of every sheet (its last row by its last column, blank
 *     formatted cells included) is read from the XML, because the library makes
 *     room for every cell in the span and one cell in the far corner of a sheet
 *     would otherwise ask for gigabytes.
 *   - Whatever the library throws is turned into a sentence. A workbook is a file
 *     a stranger made, and "it threw" is not something a person can act on.
 *
 * It is loaded when a workbook arrives, not when the server starts.
 */

/** A workbook that cannot be read, said in words a person can act on. */
export class WorkbookRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookRefused";
  }
}

export interface SheetListing {
  name: string;
  /** Rows under the header, or null when the sheet cannot be read. */
  rows: number | null;
  /** The header's first cells, so a person can tell the sheets apart. */
  header: string[];
  /** Why this sheet cannot be brought in, or null. */
  why: string | null;
}

const NOT_XLSX = "That does not look like an .xlsx workbook. Open it in your spreadsheet program, choose Save As, and pick Excel Workbook (.xlsx) or CSV.";
const DAMAGED = "That workbook could not be read. It may be damaged, or saved in a form this does not know. Open it in your spreadsheet program, choose Save As, and pick Excel Workbook (.xlsx) or CSV, and bring in that file.";

/* ---------------------------------------------------------------- the zip */

const END = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_PARTS = 2000;

interface Part { name: string; method: number; compressed: number; offset: number }

/** The parts of a zip held in memory, from its directory at the end. */
function directoryOf(bytes: Uint8Array): Part[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = view.length - 22; i >= Math.max(0, view.length - 22 - 65_535); i--) {
    if (view.readUInt32LE(i) === END) { end = i; break; }
  }
  if (end < 0) throw new WorkbookRefused(DAMAGED);
  const count = view.readUInt16LE(end + 10);
  const size = view.readUInt32LE(end + 12);
  const at = view.readUInt32LE(end + 16);
  if (count === 0xffff || size === 0xffffffff || at === 0xffffffff) {
    throw new WorkbookRefused("That workbook is larger inside than this can read. Bring in at most 5 MB at a time: split it into smaller files.");
  }
  if (count > MAX_PARTS) throw new WorkbookRefused(DAMAGED);
  if (at + size > view.length) throw new WorkbookRefused(DAMAGED);
  const parts: Part[] = [];
  let cursor = at;
  for (let n = 0; n < count; n++) {
    if (cursor + 46 > view.length || view.readUInt32LE(cursor) !== CENTRAL) throw new WorkbookRefused(DAMAGED);
    const flags = view.readUInt16LE(cursor + 8);
    const method = view.readUInt16LE(cursor + 10);
    const compressed = view.readUInt32LE(cursor + 20);
    const nameLength = view.readUInt16LE(cursor + 28);
    const extraLength = view.readUInt16LE(cursor + 30);
    const commentLength = view.readUInt16LE(cursor + 32);
    const offset = view.readUInt32LE(cursor + 42);
    const name = view.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    if ((flags & 1) !== 0) {
      throw new WorkbookRefused("That workbook is protected with a password. Open it, remove the password, save it, and bring it in again.");
    }
    parts.push({ name, method, compressed, offset });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return parts;
}

/** The parts the library opens, which are XML, opened here under a budget. */
function open(bytes: Uint8Array): Map<string, string> {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const opened = new Map<string, string>();
  let budget = rules.MAX_OPENED_BYTES;
  for (const part of directoryOf(bytes)) {
    if (!part.name.endsWith(".xml") && !part.name.endsWith(".xml.rels")) continue;
    if (part.offset + 30 > view.length || view.readUInt32LE(part.offset) !== LOCAL) throw new WorkbookRefused(DAMAGED);
    const start = part.offset + 30 + view.readUInt16LE(part.offset + 26) + view.readUInt16LE(part.offset + 28);
    const data = view.subarray(start, start + part.compressed);
    if (data.length !== part.compressed) throw new WorkbookRefused(DAMAGED);
    let text: Buffer;
    if (part.method === 0) {
      text = data;
    } else if (part.method === 8) {
      try {
        text = inflateRawSync(data, { maxOutputLength: budget });
      } catch (error) {
        if ((error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE") {
          throw new WorkbookRefused("That workbook is far larger inside than its size says, more than this can read. Bring in at most 5 MB at a time: split it into smaller files.");
        }
        throw new WorkbookRefused(DAMAGED);
      }
    } else {
      throw new WorkbookRefused(DAMAGED);
    }
    budget -= text.length;
    if (budget < 0) throw new WorkbookRefused("That workbook is far larger inside than its size says, more than this can read. Bring in at most 5 MB at a time: split it into smaller files.");
    opened.set(part.name, text.toString("utf8"));
  }
  return opened;
}

/* ------------------------------------------------------------- the layout */

const decode = (text: string) => text
  .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
  .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** One attribute of one tag, by its local name, or null. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\s(?:[A-Za-z0-9_]+:)?${name}="([^"]*)"`).exec(tag);
  return match ? decode(match[1]!) : null;
}

interface Layout { name: string; hidden: boolean; part: string | null }

/** The sheets in the order the workbook lists them, each with the part that holds its cells. */
function layoutOf(parts: Map<string, string>): Layout[] {
  const roots = parts.get("_rels/.rels") ?? "";
  let book = "xl/workbook.xml";
  for (const tag of roots.match(/<Relationship\b[^>]*>/g) ?? []) {
    if ((attribute(tag, "Type") ?? "").endsWith("/officeDocument") && attribute(tag, "Target")) {
      book = (attribute(tag, "Target") ?? book).replace(/^\//, "");
    }
  }
  const xml = parts.get(book);
  if (xml === undefined) throw new WorkbookRefused(NOT_XLSX);
  const folder = book.includes("/") ? book.slice(0, book.lastIndexOf("/") + 1) : "";
  const relsName = `${folder}_rels/${book.slice(folder.length)}.rels`;
  const targets = new Map<string, string>();
  for (const tag of parts.get(relsName)?.match(/<Relationship\b[^>]*>/g) ?? []) {
    const id = attribute(tag, "Id");
    const target = attribute(tag, "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `${folder}${target}`);
  }
  const sheets: Layout[] = [];
  for (const tag of xml.match(/<sheet\b[^>]*>/g) ?? []) {
    const name = attribute(tag, "name");
    if (name === null) continue;
    const link = attribute(tag, "id");
    sheets.push({ name, hidden: (attribute(tag, "state") ?? "visible") !== "visible", part: link ? targets.get(link) ?? null : null });
  }
  if (sheets.length === 0) throw new WorkbookRefused(NOT_XLSX);
  return sheets;
}

/** Letters of a column to its number: A is 1, AA is 27. */
const columnNumber = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);

/**
 * How far a sheet's cells reach, by reading every cell's address. A cell with
 * something in it and a cell that is only formatted (`<c r="A9" s="2"/>`) are
 * told apart, because the first is the data and the second is the span a reader
 * must make room for.
 */
function spanOf(xml: string): { dataRows: number; rows: number; columns: number } {
  let dataRows = 0;
  let rows = 0;
  let columns = 0;
  for (const match of xml.matchAll(/<c\b([^>]*?)(\/?)>/g)) {
    const at = /\sr="([A-Z]{1,3})(\d{1,7})"/.exec(match[1]!);
    if (!at) continue;
    const row = Number(at[2]);
    rows = Math.max(rows, row);
    columns = Math.max(columns, columnNumber(at[1]!));
    if (match[2] !== "/") dataRows = Math.max(dataRows, row);
  }
  return { dataRows, rows, columns };
}

/** Why a sheet's span is more than this will read, or null when it is not. */
function overSpan(name: string, xml: string | undefined): string | null {
  if (xml === undefined) return null;
  const span = spanOf(xml);
  if (span.dataRows > rules.MAX_ROWS + 1) {
    return `The sheet "${name}" has data down to row ${span.dataRows.toLocaleString("en-US")}. Bring in at most ${rules.MAX_ROWS.toLocaleString("en-US")} rows at a time: split it into smaller sheets.`;
  }
  if (span.columns > rules.MAX_COLUMNS) {
    return `The sheet "${name}" reaches column ${span.columns.toLocaleString("en-US")}. Bring in at most ${rules.MAX_COLUMNS} columns.`;
  }
  if (span.rows > rules.MAX_BLANK_ROWS || span.rows * span.columns > rules.MAX_SPAN) {
    return `The sheet "${name}" has blank formatted cells down to row ${span.rows.toLocaleString("en-US")}, far past its data. Select the empty rows and columns after your data, delete them, save the workbook, and bring it in again.`;
  }
  return null;
}

/* ------------------------------------------------------------ the library */

type Library = typeof import("read-excel-file/universal");

async function library(): Promise<Library> {
  return import("read-excel-file/universal");
}

/**
 * A sheet's cells, typed as what they are. The library declares a date cell as
 * `typeof Date` (the constructor) where it means `Date`, so its own type will not
 * go where a cell is expected; the values are strings, numbers, booleans, dates
 * and nulls, which is what `rules.WorkbookValue` says.
 */
async function cellsOf(lib: Library, bytes: Uint8Array, name: string): Promise<rules.WorkbookValue[][]> {
  return (await lib.readSheet(arrayBufferOf(bytes), name)) as unknown as rules.WorkbookValue[][];
}

/** What a library failure means to the person who sent the file. */
function refusal(error: unknown): WorkbookRefused {
  if (error instanceof WorkbookRefused) return error;
  const name = (error as { name?: string } | null)?.name;
  const code = (error as { code?: string } | null)?.code;
  if (name === "InvalidInputError") {
    if (code === "XLS_FILE_NOT_SUPPORTED") {
      return new WorkbookRefused("That is an older .xls workbook, which this cannot read. Open it, choose Save As, pick Excel Workbook (.xlsx) or CSV, and bring in that file.");
    }
    if (code === "NO_DATA") return new WorkbookRefused("That file is empty.");
    if (code === "FILE_NOT_SUPPORTED") return new WorkbookRefused(NOT_XLSX);
  }
  return new WorkbookRefused(DAMAGED);
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The checks every call makes first, and the layout they leave. */
function checked(bytes: Uint8Array): { parts: Map<string, string>; sheets: Layout[] } {
  if (bytes.byteLength === 0) throw new WorkbookRefused("That file is empty.");
  if (bytes.byteLength > rules.MAX_BYTES) throw new WorkbookRefused(rules.tooBigMessage(bytes.byteLength));
  /** D0 CF 11 E0: the container older .xls files, and password protected workbooks of any age, are kept in. */
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new WorkbookRefused("That is an older .xls workbook, or one protected with a password, which this cannot read. Open it, remove any password, choose Save As, pick Excel Workbook (.xlsx) or CSV, and bring in that file.");
  }
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) throw new WorkbookRefused(NOT_XLSX);
  const parts = open(bytes);
  const sheets = layoutOf(parts);
  if (sheets.length > rules.MAX_SHEETS) {
    throw new WorkbookRefused(`That workbook has ${sheets.length} sheets. Bring in a workbook of at most ${rules.MAX_SHEETS}: save the sheet you want on its own.`);
  }
  return { parts, sheets };
}

/** The names of a workbook's sheets, without reading any of their cells. */
export function sheetNames(bytes: Uint8Array): string[] {
  return checked(bytes).sheets.map((s) => s.name);
}

/**
 * Every sheet, with how many rows it has and what its columns are called, so a
 * person can pick one. A sheet that cannot be read says why beside its name
 * rather than failing the list, because a workbook often holds one sheet that
 * is not a list at all next to the one that is.
 */
export async function listSheets(bytes: Uint8Array): Promise<SheetListing[]> {
  const { parts, sheets } = checked(bytes);
  const lib = await library();
  const out: SheetListing[] = [];
  for (const sheet of sheets) {
    const why = overSpan(sheet.name, sheet.part ? parts.get(sheet.part) : undefined);
    if (why) { out.push({ name: sheet.name, rows: null, header: [], why }); continue; }
    try {
      const read = rules.readSheetGrid(sheet.name, await cellsOf(lib, bytes, sheet.name));
      out.push(read.ok
        ? { name: sheet.name, rows: read.rows.length, header: read.header.slice(0, 8), why: null }
        : { name: sheet.name, rows: null, header: [], why: read.why });
    } catch (error) {
      out.push({ name: sheet.name, rows: null, header: [], why: refusal(error).message });
    }
  }
  return out;
}

export interface SheetRows { sheet: string; header: string[]; rows: string[][]; numbers: number[] }

/**
 * One sheet as a header and rows of text, the shape a CSV is read into. With no
 * name, the workbook's only sheet; a workbook with several has to be told which,
 * because choosing for the owner could load the wrong list.
 */
export async function readSheet(bytes: Uint8Array, wanted: string | undefined): Promise<SheetRows> {
  const { parts, sheets } = checked(bytes);
  let sheet: Layout | undefined;
  if (wanted === undefined || wanted.trim() === "") {
    if (sheets.length > 1) {
      throw new WorkbookRefused(`That workbook has ${sheets.length} sheets: ${sheets.map((s) => `"${s.name}"`).join(", ")}. Say which one to bring in.`);
    }
    sheet = sheets[0];
  } else {
    sheet = sheets.find((s) => s.name === wanted);
    if (!sheet) {
      throw new WorkbookRefused(`That workbook has no sheet called "${wanted}". Its sheets are ${sheets.map((s) => `"${s.name}"`).join(", ")}.`);
    }
  }
  if (!sheet) throw new WorkbookRefused(NOT_XLSX);
  const why = overSpan(sheet.name, sheet.part ? parts.get(sheet.part) : undefined);
  if (why) throw new WorkbookRefused(why);
  const lib = await library();
  let grid: rules.WorkbookValue[][];
  try {
    grid = await cellsOf(lib, bytes, sheet.name);
  } catch (error) {
    throw refusal(error);
  }
  const read = rules.readSheetGrid(sheet.name, grid);
  if (!read.ok) throw new WorkbookRefused(read.why);
  return { sheet: sheet.name, header: read.header, rows: read.rows, numbers: read.numbers };
}
