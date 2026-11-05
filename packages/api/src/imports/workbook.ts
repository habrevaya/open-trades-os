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
 *
 * AN .ods IS READ THE SAME WAY, WITH NO LIBRARY AT ALL. An OpenDocument
 * spreadsheet is a zip whose `content.xml` holds every sheet, so it goes through
 * the same zip directory, the same refusal of a password, the same ceiling on
 * what its parts may open into, the same caps on rows, columns, sheets and span,
 * and the same turning of anything that goes wrong into a sentence. Its cells
 * are read by a single pass over the tags (no regular expression runs over the
 * whole file, so a hostile one cannot make it quadratic), and repeats are done
 * as arithmetic and never by building the rows they stand for: LibreOffice ends
 * every sheet with a row "repeated" a million times, and a file that repeats a
 * row of data past the row cap is refused before any of it is built. As with an
 * .xlsx, only values are read: the answer stored beside a formula and never the
 * formula, a cell showing an error is empty, and comments, pictures, merged
 * cells and hidden rows are not looked at.
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
function open(
  bytes: Uint8Array, directory: Part[] = directoryOf(bytes),
  wanted: (name: string) => boolean = (name) => name.endsWith(".xml") || name.endsWith(".xml.rels"),
): Map<string, string> {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const opened = new Map<string, string>();
  let budget = rules.MAX_OPENED_BYTES;
  for (const part of directory) {
    if (!wanted(part.name)) continue;
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

/* ------------------------------------------------------ an OpenDocument sheet */

const ODS_TYPE = "application/vnd.oasis.opendocument.spreadsheet";

/** What every reader of either kind of file hands back: the sheets' names, and one sheet's cells. */
interface Book {
  names: string[];
  cells(name: string): Promise<rules.WorkbookValue[][]>;
}

/** A tag as a scanner sees it: its name, whether it closes, whether it closes itself, and its attributes as written. */
const TAG = /<(\/?)([A-Za-z][\w:.-]*)((?:"[^"]*"|'[^']*'|[^>"'/]|\/(?!>))*)(\/?)>/g;

/** One attribute of a tag's text, decoded, or null. */
function attr(attrs: string, name: string): string | null {
  const at = attrs.search(new RegExp(`(?:^|\\s)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`));
  if (at < 0) return null;
  const match = /=\s*(?:"([^"]*)"|'([^']*)')/.exec(attrs.slice(at));
  return match ? decode(match[1] ?? match[2] ?? "") : null;
}

/** A repeat count: at least one, and anything that is not a whole number is one. */
function repeatOf(attrs: string, name: string): number {
  const said = attr(attrs, name);
  const n = said === null ? 1 : Number(said);
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
}

/** `PT14H30M00S` as a time on the day spreadsheets keep a time with no day on. */
function timeOf(said: string): Date | null {
  const match = /^P(?:(\d+)D)?T(\d+)H(\d+)M(\d+(?:\.\d+)?)S$/.exec(said.trim());
  if (!match) return null;
  const ms = ((Number(match[1] ?? 0) * 24 + Number(match[2])) * 3600 + Number(match[3]) * 60 + Number(match[4])) * 1000;
  return new Date(Date.UTC(1899, 11, 30) + ms);
}

/** `2026-01-31` or `2026-01-31T14:30:00`, as the wall clock in a date's UTC fields, the way a workbook's are. */
function dateOf(said: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/.exec(said.trim());
  if (!match) return null;
  const at = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)));
  return Number.isNaN(at.getTime()) ? null : at;
}

/**
 * One cell's value. A formula's stored answer is read and the formula never; a
 * cell the program marked as an error is empty; a cell with no type is empty.
 */
function odsValue(attrs: string, text: string): rules.WorkbookValue {
  if (attr(attrs, "calcext:value-type") === "error") return null;
  switch (attr(attrs, "office:value-type")) {
    case "float":
    case "percentage":
    case "currency": {
      const said = attr(attrs, "office:value");
      const n = said === null ? NaN : Number(said);
      return Number.isFinite(n) ? n : null;
    }
    case "date": {
      const said = attr(attrs, "office:date-value");
      return said === null ? null : dateOf(said);
    }
    case "time": {
      const said = attr(attrs, "office:time-value");
      return said === null ? null : timeOf(said);
    }
    case "boolean": {
      const said = attr(attrs, "office:boolean-value");
      return said === "true" ? true : said === "false" ? false : null;
    }
    case "string": {
      const said = attr(attrs, "office:string-value");
      const value = said ?? decode(text);
      return value === "" ? null : value;
    }
    default:
      return null;
  }
}

interface OdsSheet { name: string; xml: string }

/** The sheets of a `content.xml`, each with the text between its own tags: found in one pass over the tags. */
function odsSheets(content: string): OdsSheet[] {
  const sheets: OdsSheet[] = [];
  let depth = 0;
  let name = "";
  let from = 0;
  for (const tag of content.matchAll(TAG)) {
    if (tag[2] !== "table:table") continue;
    if (tag[1] === "") {
      if (tag[4] === "/") {
        if (depth === 0) {
          const said = attr(tag[3]!, "table:name");
          if (said !== null) sheets.push({ name: said, xml: "" });
        }
        continue;
      }
      if (depth === 0) {
        name = attr(tag[3]!, "table:name") ?? "";
        from = tag.index! + tag[0].length;
      }
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0 && name !== "") sheets.push({ name, xml: content.slice(from, tag.index!) });
    }
  }
  return sheets;
}

/**
 * One sheet's cells, in a single pass over its tags.
 *
 * ROWS AND CELLS REPEAT. `table:number-rows-repeated` and
 * `table:number-columns-repeated` say "this, a million times", and a program
 * writes one at the end of every sheet to mean "and then nothing". They are
 * counted and never built: a blank row or cell only moves the position on, and
 * a row of data that repeats is refused if its last copy would be past the row
 * cap, before one copy is made. A cell of data that repeats past the column cap
 * is refused the same way.
 *
 * The text of a cell is its paragraphs, joined with a new line; a comment on the
 * cell and a picture's caption are not its text.
 */
function odsGrid(name: string, xml: string): rules.WorkbookValue[][] {
  const grid: rules.WorkbookValue[][] = [];
  let row = 1;
  let widest = 0;
  let last = 0;

  let rowAttrs: string | null = null;
  let cells: rules.WorkbookValue[] = [];
  let column = 0;
  let hasData = false;
  let cell: { attrs: string; repeat: number; paragraphs: string[] } | null = null;
  let paragraph: string | null = null;
  let aside = 0;

  const over = (at: number) => new WorkbookRefused(
    `The sheet "${name}" has data down to row ${at.toLocaleString("en-US")}. Bring in at most ${rules.MAX_ROWS.toLocaleString("en-US")} rows at a time: split it into smaller sheets.`);

  const endCell = () => {
    if (!cell) return;
    const value = odsValue(cell.attrs, cell.paragraphs.join("\n"));
    if (value !== null) {
      if (column + cell.repeat > rules.MAX_COLUMNS) {
        throw new WorkbookRefused(`The sheet "${name}" reaches column ${(column + cell.repeat).toLocaleString("en-US")}. Bring in at most ${rules.MAX_COLUMNS} columns.`);
      }
      for (let n = 0; n < cell.repeat; n++) cells[column + n] = value;
      hasData = true;
      widest = Math.max(widest, column + cell.repeat);
    }
    column += cell.repeat;
    cell = null;
  };

  const endRow = () => {
    const repeat = repeatOf(rowAttrs ?? "", "table:number-rows-repeated");
    if (hasData) {
      if (row + repeat - 1 > rules.MAX_ROWS + 1) throw over(row + repeat - 1);
      for (let n = 0; n < repeat; n++) grid[row - 1 + n] = cells;
      last = row + repeat - 1;
    }
    row += repeat;
    rowAttrs = null;
    cells = [];
    column = 0;
    hasData = false;
  };

  let at = 0;
  for (const tag of xml.matchAll(TAG)) {
    if (paragraph !== null && aside === 0) paragraph += xml.slice(at, tag.index!);
    at = tag.index! + tag[0].length;
    const [, closing, tagName, attrs = "", selfClosing] = tag;
    if (tagName === "table:table-row") {
      if (closing === "") {
        rowAttrs = attrs;
        if (selfClosing === "/") endRow();
      } else if (rowAttrs !== null) {
        endCell();
        endRow();
      }
    } else if (rowAttrs !== null && (tagName === "table:table-cell" || tagName === "table:covered-table-cell")) {
      if (closing === "") {
        endCell();
        const repeat = repeatOf(attrs, "table:number-columns-repeated");
        if (tagName === "table:covered-table-cell") {
          column += repeat;
        } else {
          cell = { attrs, repeat, paragraphs: [] };
          if (selfClosing === "/") endCell();
        }
      } else {
        endCell();
      }
    } else if (cell !== null && aside === 0 && tagName === "text:p") {
      if (closing === "") {
        paragraph = selfClosing === "/" ? null : "";
        if (selfClosing === "/") cell.paragraphs.push("");
      } else if (paragraph !== null) {
        cell.paragraphs.push(paragraph);
        paragraph = null;
      }
    } else if (paragraph !== null && closing === "" && aside === 0) {
      if (tagName === "text:s") paragraph += " ".repeat(Math.min(repeatOf(attrs, "text:c"), 1000));
      else if (tagName === "text:tab") paragraph += "\t";
      else if (tagName === "text:line-break") paragraph += "\n";
    }
    if (tagName === "office:annotation" || tagName === "draw:frame") {
      if (closing === "") { if (selfClosing !== "/") aside += 1; } else if (aside > 0) aside -= 1;
    }
  }
  if (last > 0 && last * widest > rules.MAX_SPAN) {
    throw new WorkbookRefused(`The sheet "${name}" is larger than this can read: ${last.toLocaleString("en-US")} rows of ${widest.toLocaleString("en-US")} columns. Bring in a smaller sheet.`);
  }
  return grid;
}

/** An OpenDocument spreadsheet, opened under the same budget as a workbook. */
function odsBook(bytes: Uint8Array, directory: Part[]): Book {
  const parts = open(bytes, directory, (n) => n === "mimetype" || n === "content.xml" || n === "META-INF/manifest.xml");
  const said = (parts.get("mimetype") ?? "").trim();
  if (said !== ODS_TYPE) {
    throw new WorkbookRefused(said.startsWith("application/vnd.oasis.opendocument.")
      ? "That is an OpenDocument file, but not a spreadsheet. Open the spreadsheet in your spreadsheet program, choose Save As, and pick Excel Workbook (.xlsx), OpenDocument Spreadsheet (.ods) or CSV."
      : NOT_XLSX);
  }
  /** A protected .ods encrypts its content inside the zip, which the zip's own flag does not say. */
  if (/<manifest:encryption-data\b/.test(parts.get("META-INF/manifest.xml") ?? "")) {
    throw new WorkbookRefused("That workbook is protected with a password. Open it, remove the password, save it, and bring it in again.");
  }
  const content = parts.get("content.xml");
  if (content === undefined) throw new WorkbookRefused(DAMAGED);
  const sheets = odsSheets(content);
  if (sheets.length === 0) throw new WorkbookRefused(NOT_XLSX);
  if (sheets.length > rules.MAX_SHEETS) tooManySheets(sheets.length);
  const byName = new Map(sheets.map((sheet) => [sheet.name, sheet] as const));
  return {
    names: sheets.map((sheet) => sheet.name),
    cells: async (name) => odsGrid(name, byName.get(name)!.xml),
  };
}

function tooManySheets(count: number): never {
  throw new WorkbookRefused(`That workbook has ${count} sheets. Bring in a workbook of at most ${rules.MAX_SHEETS}: save the sheet you want on its own.`);
}

/** The checks every call makes first, and the book they leave: an .xlsx or an .ods, whichever the bytes are. */
function checked(bytes: Uint8Array): Book {
  if (bytes.byteLength === 0) throw new WorkbookRefused("That file is empty.");
  if (bytes.byteLength > rules.MAX_BYTES) throw new WorkbookRefused(rules.tooBigMessage(bytes.byteLength));
  /** D0 CF 11 E0: the container older .xls files, and password protected workbooks of any age, are kept in. */
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) {
    throw new WorkbookRefused("That is an older .xls workbook, or one protected with a password, which this cannot read. Open it, remove any password, choose Save As, pick Excel Workbook (.xlsx) or CSV, and bring in that file.");
  }
  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04)) throw new WorkbookRefused(NOT_XLSX);
  const directory = directoryOf(bytes);
  /** Every OpenDocument file carries a `mimetype` part first; an .xlsx never has one. */
  if (directory.some((part) => part.name === "mimetype")) return odsBook(bytes, directory);
  const parts = open(bytes, directory);
  const sheets = layoutOf(parts);
  if (sheets.length > rules.MAX_SHEETS) tooManySheets(sheets.length);
  return {
    names: sheets.map((s) => s.name),
    cells: async (name) => {
      const sheet = sheets.find((s) => s.name === name)!;
      const why = overSpan(sheet.name, sheet.part ? parts.get(sheet.part) : undefined);
      if (why) throw new WorkbookRefused(why);
      return cellsOf(await library(), bytes, name);
    },
  };
}

/** The names of a workbook's sheets, without reading any of their cells. */
export function sheetNames(bytes: Uint8Array): string[] {
  return checked(bytes).names;
}

/**
 * Every sheet, with how many rows it has and what its columns are called, so a
 * person can pick one. A sheet that cannot be read says why beside its name
 * rather than failing the list, because a workbook often holds one sheet that
 * is not a list at all next to the one that is.
 */
export async function listSheets(bytes: Uint8Array): Promise<SheetListing[]> {
  const book = checked(bytes);
  const out: SheetListing[] = [];
  for (const name of book.names) {
    try {
      const read = rules.readSheetGrid(name, await book.cells(name));
      out.push(read.ok
        ? { name, rows: read.rows.length, header: read.header.slice(0, 8), why: null }
        : { name, rows: null, header: [], why: read.why });
    } catch (error) {
      out.push({ name, rows: null, header: [], why: refusal(error).message });
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
  const book = checked(bytes);
  let name: string | undefined;
  if (wanted === undefined || wanted.trim() === "") {
    if (book.names.length > 1) {
      throw new WorkbookRefused(`That workbook has ${book.names.length} sheets: ${book.names.map((n) => `"${n}"`).join(", ")}. Say which one to bring in.`);
    }
    name = book.names[0];
  } else {
    name = book.names.find((n) => n === wanted);
    if (!name) {
      throw new WorkbookRefused(`That workbook has no sheet called "${wanted}". Its sheets are ${book.names.map((n) => `"${n}"`).join(", ")}.`);
    }
  }
  if (!name) throw new WorkbookRefused(NOT_XLSX);
  let grid: rules.WorkbookValue[][];
  try {
    grid = await book.cells(name);
  } catch (error) {
    throw refusal(error);
  }
  const read = rules.readSheetGrid(name, grid);
  if (!read.ok) throw new WorkbookRefused(read.why);
  return { sheet: name, header: read.header, rows: read.rows, numbers: read.numbers };
}
